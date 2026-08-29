import { useEffect, useRef, useState } from 'react';

import { api, explain } from '../api.js';
import { deviceId } from '../deviceId.js';
import { createAnnouncer, speech, SPOKEN } from '../speech.js';
import { useCamera } from '../useCamera.js';
import { CameraStage } from './CameraStage.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Capture interval, independent of how fast frames can be shipped. 15fps is
// enough that a 250ms blink covers three or four frames.
const CAPTURE_INTERVAL_MS = 66;

// Ceiling on one request. The server caps it too; this keeps a stalled upload
// from accumulating a batch too large to send.
const MAX_BATCH = 12;

/**
 * Live verification: stream frames, follow the challenge, then identify.
 *
 * Frames go out one at a time, each sent only once the previous response has
 * come back. There is no timer. A fixed interval would queue requests behind a
 * slow connection and make the whole thing lag further and further behind what
 * the camera is actually seeing; this way the rate simply becomes whatever the
 * round trip allows, and the server measures the challenge in milliseconds so
 * it holds up at either end of that range.
 *
 * The three stages are three separate effects on purpose. An effect that both
 * depends on `phase` and sets it tears itself down mid-flight: React runs the
 * cleanup as soon as the state changes, so an `await` sitting after that
 * `setPhase` resolves into a scope that has already been cancelled and its
 * result is silently dropped. That is exactly what went wrong here — the match
 * request completed with a 200 and the answer went nowhere.
 */
export function Verify({ onDone, onCancel }) {
  const [phase, setPhase] = useState('starting');
  const [identified, setIdentified] = useState(null);
  const [pin, setPin] = useState('');
  const [pinProblem, setPinProblem] = useState(null);

  // One announcer per screen, so the same line is not repeated on every
  // re-render of a camera loop that runs many times a second.
  const [announcer] = useState(createAnnouncer);
  const [liveness, setLiveness] = useState(null);
  const [error, setError] = useState(null);

  const camera = useCamera(phase === 'scanning');
  const sessionRef = useRef(null);
  const startedRef = useRef(false);

  // `useCamera` returns a fresh object every render, so depending on it would
  // tear down and restart the frame loop on every progress update. `capture`
  // is stable; the callback prop is not, so it is read through a ref.
  const { capture, status: cameraStatus } = camera;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 1. Open the session.
  useEffect(() => {
    // StrictMode runs mount effects twice in development. Without this guard
    // that means two /verify/start calls per attempt, and an orphaned session
    // left behind on the ML service each time.
    if (startedRef.current) return;
    startedRef.current = true;

    api
      .startVerification({ deviceId: deviceId('kiosk') })
      .then((started) => {
        sessionRef.current = started;
        setLiveness({
          prompt: started.prompt,
          stepIndex: 0,
          totalSteps: started.totalSteps,
          stepProgress: 0,
          status: 'in_progress',
          faceDetected: false,
        });
        setPhase('scanning');
      })
      .catch((cause) => {
        setError(cause.message);
        setPhase('error');
      });
    // Once. The session is opened one time per mount, and the guard above
    // is what makes that true under StrictMode.
  }, []);

  // 2. Stream frames until the challenge settles.
  useEffect(() => {
    if (phase !== 'scanning' || cameraStatus !== 'ready') return undefined;

    let stopped = false;
    const buffer = [];

    // Capture on a fixed timer, quite separately from sending. Tying the two
    // together made the sampling rate equal to the round trip, and at the 3-5fps
    // a tunnel allows a 250ms blink falls between two samples more often than
    // not — which is why gaze challenges passed while blink challenges failed
    // on the same connection.
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

        // Drain whatever accumulated while the previous request was in flight.
        const batch = buffer.splice(0, MAX_BATCH);

        try {
          const result = await api.submitFrames(sessionRef.current.sessionId, batch);
          if (stopped) return;

          setLiveness(result);
          if (result.status !== 'in_progress') {
            // Hand off by setting phase and returning immediately. Anything
            // awaited past this point would run in a scope React has already
            // cleaned up.
            setPhase(result.status === 'passed' ? 'identifying' : 'rejected');
            return;
          }
        } catch (cause) {
          if (stopped) return;
          setError(cause.message);
          setPhase('error');
          return;
        }
      }
    })();

    return () => {
      stopped = true;
      clearInterval(ticker);
    };
  }, [phase, cameraStatus, capture]);

  // 3. Identify, in its own effect so nothing cancels it out from under itself.
  useEffect(() => {
    if (phase !== 'identifying') return undefined;

    let cancelled = false;

    api
      .match(sessionRef.current.sessionId)
      .then((result) => {
        if (cancelled) return;

        // A match is one factor. The PIN is the other, and without it the
        // kiosk would be single-factor while the till is two.
        if (result.decision === 'matched') {
          // The name last, so the useful half arrives even if the listener
          // stops attending partway through.
          speech.say(SPOKEN.recognised(result.user.displayName));

          setIdentified(result);
          setPin('');
          setPinProblem(null);
          setPhase('pin');
          return;
        }

        speech.say(
          result.decision === 'ambiguous' ? SPOKEN.ambiguous : SPOKEN.notRecognised,
        );
        onDoneRef.current(result);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause.message);
        setPhase('error');
      });

    return () => {
      cancelled = true;
    };
  }, [phase]);

  // Said rather than only shown: the person is looking at a camera rather
  // than at text, and someone who cannot read the prompt still needs to know
  // what to do. In an effect because speaking during render happens again on
  // every re-render, and twice under StrictMode.
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

  const submitPin = async () => {
    setPhase('confirming');
    try {
      const result = await api.confirmPin(sessionRef.current.sessionId, pin);

      if (result.confirmed) {
        onDoneRef.current({ ...identified, confirmed: true });
        return;
      }

      // A wrong PIN with tries left keeps the scan, so one mistyped digit does
      // not cost another round in front of the camera.
      if (result.pinOutcome === 'wrong_pin') {
        speech.say(SPOKEN.wrongPin);
        setPinProblem(result.reason);
        setPin('');
        setPhase('pin');
        return;
      }

      onDoneRef.current({ ...identified, confirmed: false, ...result });
    } catch (cause) {
      setError(cause.message);
      setPhase('error');
    }
  };

  if (phase === 'pin' || phase === 'confirming') {
    return (
      <PinStep
        name={identified?.user?.displayName}
        pin={pin}
        onPin={setPin}
        problem={pinProblem}
        busy={phase === 'confirming'}
        onSubmit={submitPin}
        onCancel={onCancel}
      />
    );
  }

  if (phase === 'error') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge fail">!</div>
          <h2>Something went wrong</h2>
          <p className="muted">{error}</p>
        </div>
        <button className="btn btn-primary" onClick={onCancel}>
          Back to start
        </button>
      </div>
    );
  }

  if (phase === 'rejected') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge fail">✕</div>
          <h2>Liveness check failed</h2>
          <p className="muted">
            {explain(liveness?.failureReason) ??
              'We could not confirm a live person was present.'}
          </p>
        </div>
        <p className="note">
          This check is what stops someone paying with a photo or a recording of
          your face. It is meant to be strict.
        </p>
        <button className="btn btn-primary" onClick={onCancel}>
          Try again
        </button>
      </div>
    );
  }

  // The camera is released the moment scanning ends, so there is no preview to
  // show while matching runs. Leaving the empty stage up read as a frozen
  // screen — which is what a blank black rectangle always reads as.
  if (phase === 'identifying') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="spinner" />
          <h2>Working out who you are</h2>
          <p className="muted">Comparing against everyone enrolled.</p>
        </div>
      </div>
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
          <i className="dot live" />
          {scanning ? 'Scanning' : liveness?.faceDetected ? 'Live' : 'Looking for you'}
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
              : 'Centre your face in the oval'}
          </p>

          <div className="track">
            <i
              style={{
                width: `${Math.round((liveness?.stepProgress ?? 0) * 100)}%`,
              }}
            />
          </div>

          {/* Only a challenge has a sequence worth showing. Passive mode has
              the filling bar above and nothing else, which is the whole point
              of it. */}
          {!passive && (
            <div className="steps">
              {Array.from({ length: total }, (_, i) => (
                <span
                  key={i}
                  className={i < step ? 'done' : i === step ? 'active' : ''}
                />
              ))}
            </div>
          )}
        </div>
      </CameraStage>

      <button className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/**
 * The second factor, at the customer kiosk.
 *
 * Shown only once the face has been identified, because until then there is
 * nobody whose PIN to check. That order is also what makes the screen make
 * sense to the person: they are approving, not identifying, and the name at
 * the top is what tells them the system already knows which of those it is
 * doing.
 *
 * The same shape as the till's keypad rather than a text field. A four-digit
 * secret typed on a phone keyboard in public is a four-digit secret typed in
 * public; large keys with no preview at least keep it off the screen.
 */
function PinStep({ name, pin, onPin, problem, busy, onSubmit, onCancel }) {
  const press = (digit) => {
    if (busy || pin.length >= 4) return;
    onPin(pin + digit);
  };

  // Submits itself on the fourth digit, the way a phone lock screen and every
  // UPI app do. There was a button, and on a phone it sat below the keypad and
  // below the fold -- someone would enter their PIN and find nothing to press.
  // Removing the step is better than making room for it: nobody expects to
  // confirm a PIN they have just finished typing.
  // Held in a ref because the callback is a new function on every parent
  // render: depending on it directly would clear and rebuild the timer
  // each time, and a timer that keeps restarting never fires.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  useEffect(() => {
    if (pin.length !== 4 || busy) return undefined;
    // A beat, so the fourth dot is visibly filled before the screen changes.
    const timer = setTimeout(() => submitRef.current(), 180);
    return () => clearTimeout(timer);
  }, [pin, busy]);

  return (
    <div className="screen">
      <div className="card verdict">
        <div className="badge">✓</div>
        <h2>{name ?? 'Recognised'}</h2>
        <p className="muted">
          That is your face. Enter your PIN to approve.
        </p>
      </div>

      {problem && <p className="note bad">{problem}</p>}

      <div className="pin-dots">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < pin.length ? 'filled' : ''} />
        ))}
      </div>

      <div className="keypad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <button
            key={d}
            className="key"
            disabled={busy}
            onClick={() => press(String(d))}
          >
            {d}
          </button>
        ))}
        <button className="key key-quiet" disabled={busy} onClick={() => onPin('')}>
          Clear
        </button>
        <button className="key" disabled={busy} onClick={() => press('0')}>
          0
        </button>
        <button
          className="key key-quiet"
          disabled={busy}
          onClick={() => onPin(pin.slice(0, -1))}
        >
          ⌫
        </button>
      </div>

      <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>
        {busy ? 'Checking…' : 'Cancel'}
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
