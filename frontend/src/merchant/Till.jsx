import { useCallback, useEffect, useRef, useState } from 'react';

import { api, explain } from '../api.js';
import { CameraStage } from '../components/CameraStage.jsx';
import { useCamera } from '../useCamera.js';
import { merchantApi } from './api.js';

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

  const camera = useCamera(phase === 'scanning');
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
      .charge(sessionRef.current.sessionId, rupees)
      .then((result) => {
        if (cancelled) return;
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
    setLiveness(null);
    setOutcome(null);
    setError(null);
    setPhase('amount');
  }, []);

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

  if (phase === 'done' && outcome) {
    return <Outcome outcome={outcome} amount={rupees} onDone={reset} />;
  }

  const total = liveness?.totalSteps ?? 2;
  const step = liveness?.stepIndex ?? 0;

  return (
    <div className="screen">
      <CameraStage camera={camera}>
        <span className={`pill${liveness?.faceDetected ? '' : ' warn'}`}>
          <i className="dot live" />₹{rupees}
        </span>

        <div>
          <p className="prompt">{liveness?.prompt ?? 'Get ready'}</p>
          <p className="prompt-hint">
            {liveness?.faceDetected
              ? 'Follow the prompt'
              : 'One person in frame, facing the camera'}
          </p>
          <div className="track">
            <i style={{ width: `${Math.round((liveness?.stepProgress ?? 0) * 100)}%` }} />
          </div>
          <div className="steps">
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={i < step ? 'done' : i === step ? 'active' : ''} />
            ))}
          </div>
        </div>
      </CameraStage>

      <button className="btn btn-ghost" onClick={reset}>
        Cancel
      </button>
    </div>
  );
}

function Outcome({ outcome, amount, onDone }) {
  if (!outcome.charged) {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className={`badge ${outcome.decision === 'ambiguous' ? 'unsure' : 'fail'}`}>
            {outcome.decision === 'ambiguous' ? '?' : '✕'}
          </div>
          <h2>
            {outcome.decision === 'ambiguous' ? 'Not certain enough' : 'Not recognised'}
          </h2>
          <p className="muted">{outcome.reason}</p>
        </div>

        <dl className="scores">
          <div>
            <dt>Best</dt>
            <dd>{outcome.confidence.top?.toFixed(3) ?? '—'}</dd>
          </div>
          <div>
            <dt>Runner-up</dt>
            <dd>{outcome.confidence.runnerUp?.toFixed(3) ?? '—'}</dd>
          </div>
          <div>
            <dt>Gap</dt>
            <dd>{outcome.confidence.margin?.toFixed(3) ?? '—'}</dd>
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
          Identified by face alone. Nothing was presented at the till.
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

      <button className="btn btn-primary" onClick={onDone}>
        Next customer
      </button>
    </div>
  );
}
