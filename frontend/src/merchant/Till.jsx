import { useCallback, useEffect, useRef, useState } from 'react';

import { api, explain } from '../api.js';
import { CameraStage } from '../components/CameraStage.jsx';
import { useCamera } from '../useCamera.js';
import { merchantApi } from './api.js';
import { createAnnouncer, speech, SPOKEN } from '../speech.js';
import { Receipt } from './Receipt.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CAPTURE_INTERVAL_MS = 66;
const MAX_BATCH = 12;

/**
 * The till: enter an amount, scan a face, charge.
 *
 * The amount is entered before the scan and sent with the charge in one call.
 * Identifying first and attaching an amount afterwards would leave a window
 * where a completed scan could be billed for anything — the amount has to be
 * part of what the customer's face authorised.
 */
export function Till({ merchant, onSignOut }) {
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState('amount');
  const [liveness, setLiveness] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const [pin, setPin] = useState('');
  const [pinPrompt, setPinPrompt] = useState(null);
  const [announcer] = useState(createAnnouncer);

  const camera = useCamera(phase === 'scanning');
  // Read through a ref so submitting a PIN does not re-run the charge effect
  // on every keystroke.
  const pinRef = useRef('');
  pinRef.current = pin;
  const { capture, status: cameraStatus } = camera;
  const sessionRef = useRef(null);

  const rupees = Number(amount);
  const amountValid = Number.isFinite(rupees) && rupees >= 1;

  const beginScan = async (event) => {
    event.preventDefault();
    setError(null);
    setOutcome(null);

    try {
      const started = await api.startVerification({
        merchantId: merchant.merchantId,
        deviceId: 'till',
        region: merchant.region,
      });
      sessionRef.current = started;
      setLiveness({
        prompt: started.prompt,
        stepIndex: 0,
        totalSteps: started.totalSteps,
        stepProgress: 0,
        faceDetected: false,
      });
      setPhase('scanning');
    } catch (cause) {
      setError(cause.message);
    }
  };

  // Capture on a fixed timer and ship whatever accumulated. Tying the two
  // together would make the sampling rate equal to the round trip, and a
  // 250ms blink falls between samples at the rate a network allows.
  useEffect(() => {
    if (phase !== 'scanning' || cameraStatus !== 'ready') return undefined;

    let stopped = false;
    const buffer = [];

    const ticker = setInterval(() => {
      if (buffer.length >= MAX_BATCH) buffer.shift();
      const image = capture();
      if (image) buffer.push({ image, capturedAtMs: performance.now() });
    }, CAPTURE_INTERVAL_MS);

    (async () => {
      while (!stopped) {
        if (buffer.length === 0) {
          await sleep(CAPTURE_INTERVAL_MS);
          continue;
        }

        try {
          const result = await api.submitFrames(
            sessionRef.current.sessionId,
            buffer.splice(0, MAX_BATCH),
          );
          if (stopped) return;

          setLiveness(result);
          if (result.status !== 'in_progress') {
            setPhase(result.status === 'passed' ? 'charging' : 'rejected');
            return;
          }
        } catch (cause) {
          if (stopped) return;
          setError(cause.message);
          setPhase('failed');
          return;
        }
      }
    })();

    return () => {
      stopped = true;
      clearInterval(ticker);
    };
  }, [phase, cameraStatus, capture]);

  // Charging lives in its own effect. An effect that both depends on `phase`
  // and sets it tears itself down mid-flight, and the awaited result lands in
  // a scope React has already cancelled.
  useEffect(() => {
    if (phase !== 'charging') return undefined;

    let cancelled = false;

    merchantApi
      .charge(sessionRef.current.sessionId, rupees, pinRef.current || null)
      .then((result) => {
        if (cancelled) return;

        // Identified, but the second factor is still outstanding. The till
        // could not have asked sooner — it did not know whose PIN to want.
        if (result.needsPin) {
          // The shopkeeper hears who was recognised without looking up from
          // the counter, and the customer hears their own name confirmed
          // before being asked to approve.
          speech.say(SPOKEN.recognised(result.customer.name));
          setPinPrompt(result);
          setPin('');
          setPhase('pin');
          return;
        }

        if (result.charged) {
          speech.say(SPOKEN.paid(rupees, result.customer.name));
        } else if (result.pinOutcome === 'locked') {
          speech.say(SPOKEN.pinLocked);
        } else if (!result.customer) {
          speech.say(SPOKEN.notRecognised);
        }

        setOutcome(result);
        setPhase('done');
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause.message);
        setPhase('failed');
      });

    return () => {
      cancelled = true;
    };
  }, [phase, rupees]);

  const reset = useCallback(() => {
    setAmount('');
    setPin('');
    setPinPrompt(null);
    setLiveness(null);
    setOutcome(null);
    setError(null);
    setPhase('amount');
  }, []);

  // See the note in Verify: announcements go in effects, not in render.
  useEffect(() => {
    if (phase !== 'scanning') return;
    announcer.announce(
      liveness?.faceDetected
        ? liveness.totalSteps === 0
          ? SPOKEN.scanning
          : liveness.prompt
        : SPOKEN.noFace,
    );
  }, [phase, announcer, liveness?.faceDetected, liveness?.prompt, liveness?.totalSteps]);

  useEffect(() => {
    if (phase === 'rejected') speech.say(spokenFailure(liveness?.failureReason));
  }, [phase, liveness?.failureReason]);

  if (phase === 'amount') {
    return (
      <div className="screen">
        <form className="card stack" onSubmit={beginScan}>
          <h2>Take a payment</h2>
          <div className="field">
            <label htmlFor="amount">Amount</label>
            <input
              id="amount"
              type="number"
              inputMode="decimal"
              min="1"
              step="1"
              placeholder="0"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              autoFocus
            />
          </div>
          <button className="btn btn-primary" disabled={!amountValid}>
            {amountValid ? `Scan for ₹${rupees}` : 'Enter an amount'}
          </button>
          {error && <p className="note bad">{error}</p>}
        </form>

        <p className="note">
          The customer needs nothing — no phone, no card. Ask them to look at
          the camera and follow the prompt.
        </p>

        <button className="btn btn-ghost" onClick={onSignOut}>
          Sign out of {merchant.name}
        </button>
      </div>
    );
  }

  if (phase === 'charging') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="spinner" />
          <h2>Identifying…</h2>
          <p className="muted">Comparing against every enrolled customer.</p>
        </div>
      </div>
    );
  }

  if (phase === 'pin') {
    return (
      <PinEntry
        prompt={pinPrompt}
        amount={rupees}
        pin={pin}
        onPin={setPin}
        onSubmit={() => setPhase('charging')}
        onCancel={reset}
      />
    );
  }

  if (phase === 'rejected' || phase === 'failed') {
    const isLiveness = phase === 'rejected';
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge fail">✕</div>
          <h2>{isLiveness ? 'Liveness check failed' : 'Could not take payment'}</h2>
          <p className="muted">
            {isLiveness
              ? (explain(liveness?.failureReason) ??
                'We could not confirm a live person was present.')
              : error}
          </p>
        </div>
        {isLiveness && (
          <p className="note">
            This is what stops someone paying with a photo of a customer's face.
            It is meant to be strict.
          </p>
        )}
        <button className="btn btn-primary" onClick={reset}>
          Start over
        </button>
      </div>
    );
  }

  if (phase === 'receipt' && outcome) {
    return (
      <Receipt
        merchant={merchant}
        payment={{
          amount: rupees,
          customer: outcome.customer.name,
          authFactors: outcome.authFactors,
          transactionId: outcome.transactionId,
          orderId: outcome.orderId,
        }}
        onDone={reset}
      />
    );
  }

  if (phase === 'done' && outcome) {
    return (
      <Outcome
        outcome={outcome}
        amount={rupees}
        onReceipt={() => setPhase('receipt')}
        onDone={reset}
      />
    );
  }

  // Zero steps means the server is running passively: it is watching rather
  // than asking, so there is no sequence to draw dots for.
  const total = liveness?.totalSteps ?? 0;
  const step = liveness?.stepIndex ?? 0;
  const passive = total === 0;
  const scanning = passive && liveness?.faceDetected;

  return (
    <div className="screen">
      <CameraStage camera={camera} guide={liveness?.faceDetected ? 'ok' : 'warn'}>
        <span className={`pill${liveness?.faceDetected ? '' : ' warn'}`}>
          <i className="dot live" />₹{rupees}
        </span>

        <div>
          <p className="prompt">
            {passive
              ? scanning
                ? 'Scanning your face'
                : 'Look at the camera'
              : (liveness?.prompt ?? 'Get ready')}
          </p>
          <p className="prompt-hint">
            {liveness?.faceDetected
              ? passive
                ? 'Hold still for a moment'
                : 'Follow the prompt'
              : 'One person in frame, facing the camera'}
          </p>
          <div className="track">
            <i style={{ width: `${Math.round((liveness?.stepProgress ?? 0) * 100)}%` }} />
          </div>
          {/* Only a challenge has a sequence worth showing. Passive mode has
              the filling bar above and nothing else, which is the point. */}
          {!passive && (
            <div className="steps">
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className={i < step ? 'done' : i === step ? 'active' : ''} />
              ))}
            </div>
          )}
        </div>
      </CameraStage>

      <button className="btn btn-ghost" onClick={reset}>
        Cancel
      </button>
    </div>
  );
}

function Outcome({ outcome, amount, onReceipt, onDone }) {
  if (!outcome.charged) {
    // A refused payment has three quite different causes, and saying "not
    // recognised" for all of them would be wrong twice over: a locked PIN
    // means the face *was* recognised, and the customer should be told that
    // rather than left thinking the camera failed to see them.
    const kind = outcome.pinOutcome ?? outcome.decision;
    const heading = {
      locked: 'PIN locked',
      no_pin_set: 'No PIN set',
      ambiguous: 'Not certain enough',
    }[kind] ?? 'Not recognised';

    return (
      <div className="screen">
        <div className="card verdict">
          <div className={`badge ${kind === 'ambiguous' || outcome.pinOutcome ? 'unsure' : 'fail'}`}>
            {outcome.pinOutcome ? '!' : kind === 'ambiguous' ? '?' : '✕'}
          </div>
          <h2>{heading}</h2>
          {outcome.customer && (
            <p className="muted">Recognised as {outcome.customer.name}.</p>
          )}
          <p className="muted">{outcome.reason}</p>
        </div>

        <dl className="scores">
          <div>
            <dt>Best</dt>
            <dd>{outcome.confidence?.top?.toFixed(3) ?? '—'}</dd>
          </div>
          <div>
            <dt>Runner-up</dt>
            <dd>{outcome.confidence?.runnerUp?.toFixed(3) ?? '—'}</dd>
          </div>
          <div>
            <dt>Gap</dt>
            <dd>{outcome.confidence?.margin?.toFixed(3) ?? '—'}</dd>
          </div>
        </dl>

        <button className="btn btn-primary" onClick={onDone}>
          Start over
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="card verdict">
        <div className="badge">✓</div>
        <h2>₹{amount} from {outcome.customer.name}</h2>
        <p className="muted">
          Face and PIN. Nothing was presented at the till — no phone, no card.
        </p>
      </div>

      <dl className="scores">
        <div>
          <dt>Match</dt>
          <dd>{outcome.confidence.top?.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Runner-up</dt>
          <dd>{outcome.confidence.runnerUp?.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Compared</dt>
          <dd>{outcome.gallerySize}</dd>
        </div>
      </dl>

      {outcome.orderId && (
        <p className="note">
          Razorpay order <strong>{outcome.orderId}</strong>
        </p>
      )}

      {/* Said plainly rather than implying money has moved. Test mode cannot
          register the mandate a real debit would run against. */}
      <p className="note warn">{outcome.settlement}</p>

      {/* The customer arrived with nothing and leaves with nothing, which is
          the point of the system and also the one thing that feels unfinished
          at a counter. Offered rather than forced: most people will not want
          one, and printing by default wastes a roll. */}
      <button className="btn btn-secondary" onClick={onReceipt}>
        Receipt
      </button>
      <button className="btn btn-primary" onClick={onDone}>
        Next customer
      </button>
    </div>
  );
}

/**
 * The second factor, entered on the till after the face has been identified.
 *
 * Shown only once the customer is known, because the till cannot ask for a PIN
 * until it knows whose to check against. Naming the customer here is also what
 * makes the prompt make sense to them — they are confirming, not identifying.
 */
function PinEntry({ prompt, amount, pin, onPin, onSubmit, onCancel }) {
  const press = (digit) => {
    if (pin.length >= 4) return;
    onPin(pin + digit);
  };

  // Same as the kiosk: the fourth digit submits. A customer typing their PIN
  // at a counter should not then have to hunt for a button, least of all one
  // that can fall below the fold on a phone-sized till.
  // Held in a ref because the callback is a new function on every parent
  // render: depending on it directly would clear and rebuild the timer
  // each time, and a timer that keeps restarting never fires.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  useEffect(() => {
    if (pin.length !== 4) return undefined;
    const timer = setTimeout(() => submitRef.current(), 180);
    return () => clearTimeout(timer);
  }, [pin]);

  return (
    <div className="screen">
      <div className="card verdict">
        <div className="badge">✓</div>
        <h2>{prompt.customer.name}</h2>
        <p className="muted">
          Recognised. Enter your PIN to approve ₹{amount}.
        </p>
      </div>

      {prompt.pinOutcome === 'wrong_pin' && (
        <p className="note bad">
          {prompt.reason}
        </p>
      )}

      <div className="pin-dots">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < pin.length ? 'filled' : ''} />
        ))}
      </div>

      <div className="keypad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <button key={d} className="key" onClick={() => press(String(d))}>
            {d}
          </button>
        ))}
        <button className="key key-quiet" onClick={() => onPin('')}>
          Clear
        </button>
        <button className="key" onClick={() => press('0')}>
          0
        </button>
        <button className="key key-quiet" onClick={() => onPin(pin.slice(0, -1))}>
          ⌫
        </button>
      </div>

      <button className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** What a liveness refusal should sound like, which is not what it reads like. */
function spokenFailure(reason) {
  if (!reason) return SPOKEN.livenessFailed;
  if (reason.startsWith('presentation_attack')) return SPOKEN.presentationAttack;
  if (reason === 'too_many_faces') return SPOKEN.tooManyFaces;
  return SPOKEN.livenessFailed;
}
