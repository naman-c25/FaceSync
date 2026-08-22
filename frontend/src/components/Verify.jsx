import { useEffect, useRef, useState } from 'react';

import { api, explain } from '../api.js';
import { useCamera } from '../useCamera.js';
import { CameraStage } from './CameraStage.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Live verification: stream frames, follow the challenge, then identify.
 *
 * Frames go out one at a time, each sent only once the previous response has
 * come back. There is no timer. A fixed interval would queue requests behind a
 * slow connection and make the whole thing lag further and further behind what
 * the camera is actually seeing; this way the rate simply becomes whatever the
 * round trip allows, and the server measures the challenge in milliseconds so
 * it holds up at either end of that range.
 */
export function Verify({ merchantId, onDone, onCancel }) {
  const [phase, setPhase] = useState('starting');
  const [liveness, setLiveness] = useState(null);
  const [error, setError] = useState(null);

  const camera = useCamera(phase === 'scanning');
  const sessionRef = useRef(null);

  // `useCamera` returns a fresh object every render, so depending on it would
  // tear down and restart the frame loop on every progress update. `capture`
  // is stable; the callback prop is not, so it is read through a ref.
  const { capture, status: cameraStatus } = camera;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;

    api
      .startVerification({ merchantId, deviceId: 'web-kiosk' })
      .then((started) => {
        if (cancelled) return;
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
        if (cancelled) return;
        setError(cause.message);
        setPhase('error');
      });

    return () => {
      cancelled = true;
    };
  }, [merchantId]);

  useEffect(() => {
    if (phase !== 'scanning' || cameraStatus !== 'ready') return undefined;

    let stopped = false;

    (async () => {
      let outcome = null;

      while (!stopped) {
        const image = capture();
        if (!image) {
          await sleep(80);
          continue;
        }

        try {
          const result = await api.submitFrame(sessionRef.current.sessionId, image);
          if (stopped) return;

          setLiveness(result);
          if (result.status !== 'in_progress') {
            outcome = result;
            break;
          }
        } catch (cause) {
          if (stopped) return;
          setError(cause.message);
          setPhase('error');
          return;
        }
      }

      if (stopped || !outcome) return;

      if (outcome.status !== 'passed') {
        setPhase('rejected');
        return;
      }

      setPhase('identifying');
      try {
        const result = await api.match(sessionRef.current.sessionId);
        if (!stopped) onDoneRef.current(result);
      } catch (cause) {
        if (stopped) return;
        setError(cause.message);
        setPhase('error');
      }
    })();

    return () => {
      stopped = true;
    };
  }, [phase, cameraStatus, capture]);

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

  const total = liveness?.totalSteps ?? 2;
  const step = liveness?.stepIndex ?? 0;
  const identifying = phase === 'identifying';

  return (
    <div className="screen">
      <CameraStage camera={camera}>
        <span className={`pill${liveness?.faceDetected ? '' : ' warn'}`}>
          <i className="dot live" />
          {identifying
            ? 'Identifying'
            : liveness?.faceDetected
              ? 'Live'
              : 'Looking for you'}
        </span>

        <div>
          <p className="prompt">
            {identifying ? 'Who is this…' : (liveness?.prompt ?? 'Get ready')}
          </p>
          <p className="prompt-hint">
            {identifying
              ? 'Comparing against everyone enrolled'
              : liveness?.faceDetected
                ? 'Follow the prompt'
                : 'Centre your face in the frame'}
          </p>

          <div className="track">
            <i
              style={{
                width: `${Math.round((liveness?.stepProgress ?? 0) * 100)}%`,
              }}
            />
          </div>

          <div className="steps">
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={i < step ? 'done' : i === step ? 'active' : ''}
              />
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
