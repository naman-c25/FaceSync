import { useEffect, useRef, useState } from 'react';

import { api, explain } from '../api.js';
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
export function Verify({ merchantId, onDone, onCancel }) {
  const [phase, setPhase] = useState('starting');
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
      .startVerification({ merchantId, deviceId: 'web-kiosk' })
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
  }, [merchantId]);

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
        if (!cancelled) onDoneRef.current(result);
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

  const total = liveness?.totalSteps ?? 2;
  const step = liveness?.stepIndex ?? 0;

  return (
    <div className="screen">
      <CameraStage camera={camera}>
        <span className={`pill${liveness?.faceDetected ? '' : ' warn'}`}>
          <i className="dot live" />
          {liveness?.faceDetected ? 'Live' : 'Looking for you'}
        </span>

        <div>
          <p className="prompt">{liveness?.prompt ?? 'Get ready'}</p>
          <p className="prompt-hint">
            {liveness?.faceDetected
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
