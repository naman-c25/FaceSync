import { useCallback, useEffect, useRef, useState } from 'react';

import { api, explain } from '../api.js';
import { useCamera } from '../useCamera.js';
import { CameraStage } from './CameraStage.jsx';

const COUNTDOWN_MS = 2600;

/**
 * Guided enrollment: a few samples at different angles, fused server-side.
 *
 * Samples are taken on a countdown rather than a button press. On a phone,
 * reaching for a control moves the head and hand at the exact moment the frame
 * is grabbed — which is how you collect the blurred, off-angle samples that
 * make every later match worse.
 */
export function Enroll({ onDone, onCancel }) {
  const [phase, setPhase] = useState('name');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  const [session, setSession] = useState(null);
  const [collected, setCollected] = useState(0);
  const [rejection, setRejection] = useState(null);
  const [countdown, setCountdown] = useState(3);
  const [error, setError] = useState(null);

  const camera = useCamera(phase === 'capturing');
  const busy = useRef(false);

  // `useCamera` hands back a fresh object every render, so depending on it
  // would restart the countdown on every state change. `capture` itself is
  // stable; the callback prop is not, so it is read through a ref.
  const { capture, status: cameraStatus } = camera;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const pinRef = useRef('');
  pinRef.current = pin;

  const start = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      setSession(await api.startEnrollment({ displayName: name.trim() }));
      setPhase('capturing');
    } catch (cause) {
      setError(cause.message);
    }
  };

  // Both fields, because the PIN is now the only thing standing between a
  // recognised face and a payment, and the input is masked. A typo here is not
  // a wasted registration — it is being locked out at a till three wrong
  // attempts later, with no idea why.
  const pinComplete = /^\d{4}$/.test(pin);
  const pinsMatch = pin === pinAgain;
  const pinValid = pinComplete && pinsMatch;

  const takeSample = useCallback(async () => {
    if (busy.current || !session) return;
    const image = capture();
    if (!image) return;

    busy.current = true;
    try {
      const result = await api.captureSample(session.sessionId, image);
      setCollected(result.samplesCollected);
      setRejection(result.accepted ? null : explain(result.reason));

      if (result.samplesCollected >= result.samplesRequired) {
        setPhase('finalising');
        const done = await api.finalizeEnrollment(session.sessionId, pinRef.current);
        onDoneRef.current({ ...done, name: name.trim() });
      }
    } catch (cause) {
      setError(cause.message);
      setPhase('failed');
    } finally {
      busy.current = false;
    }
  }, [capture, session, name]);

  // Countdown, then capture, then reset for the next sample.
  useEffect(() => {
    if (phase !== 'capturing' || cameraStatus !== 'ready') return undefined;

    setCountdown(3);
    const started = Date.now();

    const ticker = setInterval(() => {
      const remaining = Math.ceil((COUNTDOWN_MS - (Date.now() - started)) / 1000);
      setCountdown(Math.max(remaining, 0));
    }, 200);

    const shot = setTimeout(takeSample, COUNTDOWN_MS);

    return () => {
      clearInterval(ticker);
      clearTimeout(shot);
    };
    // `collected` restarts the countdown after each sample lands; `rejection`
    // restarts it after one is turned away.
  }, [phase, cameraStatus, collected, rejection, takeSample]);

  if (phase === 'name') {
    return (
      <div className="screen">
        <div className="stack">
          <h1>Register your face</h1>
          <p className="lede">
            A few shots from slightly different angles. It takes about fifteen
            seconds.
          </p>
        </div>

        <form className="card stack" onSubmit={start}>
          <div className="field">
            <label htmlFor="name">What should we call you?</label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              autoComplete="name"
              maxLength={120}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="pin">Choose a PIN</label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="4 digits"
              value={pin}
              onChange={(event) =>
                setPin(event.target.value.replace(/\D/g, '').slice(0, 4))
              }
              required
            />
          </div>

          <div className="field">
            <label htmlFor="pin-again">Enter it again</label>
            <input
              id="pin-again"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="4 digits"
              value={pinAgain}
              onChange={(event) =>
                setPinAgain(event.target.value.replace(/\D/g, '').slice(0, 4))
              }
              required
            />
          </div>

          {pinComplete && pinAgain.length === 4 && !pinsMatch && (
            <p className="note bad">Those two do not match.</p>
          )}

          <p className="note">
            Your face says who you are; the PIN is how you approve a payment.
            Both are needed, so pick something you will remember — and not a
            birth year or 1234.
          </p>

          <button className="btn btn-primary" disabled={!name.trim() || !pinValid}>
            Start
          </button>
          {error && <p className="note bad">{error}</p>}
        </form>

        <button className="btn btn-ghost" onClick={onCancel}>
          Back
        </button>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge fail">!</div>
          <h2>Enrollment stopped</h2>
          <p className="muted">{error}</p>
        </div>
        <button className="btn btn-primary" onClick={onCancel}>
          Back to start
        </button>
      </div>
    );
  }

  const required = session?.samplesRequired ?? 5;
  const guidance = session?.guidance ?? [];
  const prompt = guidance[Math.min(collected, guidance.length - 1)] ?? 'Hold still';

  return (
    <div className="screen">
      <CameraStage camera={camera}>
        <span className="pill">
          <i className="dot live" />
          Sample {Math.min(collected + 1, required)} of {required}
        </span>

        <div>
          <p className="prompt">
            {phase === 'finalising' ? 'Almost done…' : prompt}
          </p>
          <p className="prompt-hint">
            {rejection ??
              (phase === 'finalising'
                ? 'Building your signature'
                : countdown > 0
                  ? `Capturing in ${countdown}`
                  : 'Hold still')}
          </p>
          <div className="steps">
            {Array.from({ length: required }, (_, i) => (
              <span key={i} className={i < collected ? 'done' : ''} />
            ))}
          </div>
        </div>
      </CameraStage>

      <button className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
