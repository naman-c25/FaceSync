import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A stand-in for the Python ML service.
 *
 * The backend is tested against this rather than the real service so the suite
 * stays fast and deterministic — and so failure paths that are awkward to
 * provoke with a real camera (a liveness timeout, an ambiguous match, the
 * service being down) can simply be asked for.
 *
 * It speaks real HTTP rather than stubbing `fetch`, which keeps the client's
 * own behaviour under test: timeout handling, status mapping, and the way a
 * FastAPI `detail` payload is unwrapped.
 */
export function createFakeMlService({ port = 8099 } = {}) {
  const state = {
    // Tests mutate these to steer the next response.
    livenessOutcome: 'in_progress',
    matchDecision: 'matched',
    matchUserId: null,
    topScore: 0.82,
    runnerUpScore: 0.31,
    enrollmentAccepts: true,
    duplicateScore: 0.05,
    compareRunnerUp: 0.1,
    compareUserId: null,
    modelsLoaded: true,
    failNextRequest: null, // { status, detail }
    delayMs: 0,
    requests: [],
  };

  const signals = (challenge = ['Blink 2 times', 'Look to your left']) => ({
    frames_processed: 24,
    frames_without_face: 1,
    frames_ear_unusable: 2,
    blinks_detected: 2,
    ear_min: 0.07,
    ear_max: 0.33,
    ear_open_baseline: 0.33,
    ear_threshold_used: 0.18,
    gaze_min: 0.44,
    gaze_max: 0.58,
    yaw_min: 0.47,
    yaw_max: 0.61,
    head_motion_px: 142.5,
    elapsed_seconds: 3.2,
    challenge,
  });

  const embeddingB64 = () => {
    const vector = Buffer.alloc(512 * 4);
    for (let i = 0; i < 512; i += 1) vector.writeFloatLE(1 / Math.sqrt(512), i * 4);
    return vector.toString('base64');
  };

  const routes = {
    'POST /enroll/start': () => ({
      session_id: randomUUID(),
      samples_required: 5,
      guidance: ['Look straight at the camera', 'Turn your head slightly left'],
    }),

    'POST /enroll/capture': (body) => ({
      accepted: state.enrollmentAccepts,
      samples_collected: state.enrollmentAccepts ? (body.__count ?? 1) : 0,
      samples_required: 5,
      reason: state.enrollmentAccepts ? null : 'frame_too_blurry',
      sharpness: 92.4,
      detection_score: 0.94,
    }),

    'POST /enroll/finalize': () => ({
      embedding_b64: embeddingB64(),
      samples_used: 5,
      per_sample_similarity: [0.97, 0.95, 0.96, 0.94, 0.97],
      mean_similarity: 0.958,
      outliers_dropped: 0,
    }),

    // `compareRunnerUp` scores every candidate below the top one. It defaults
    // to a nothing score, but a test can raise it to put a second face above
    // the duplicate threshold — which is what happens once the gallery holds
    // benchmark rows and the highest scorer is not the one that matters.
    'POST /compare': (body) => {
      // `compareUserId` names who the comparison should land on. The default of
      // "whatever is first in the gallery" is fine for the duplicate check, but
      // the widened second-tier search exists precisely to find someone the
      // narrow pool left out, so a test has to be able to say who that is.
      const winner =
        state.compareUserId ??
        body.gallery[0]?.user_id ??
        null;
      const matched = state.duplicateScore >= 0.45;

      return {
        decision: matched ? 'matched' : 'no_match',
        user_id: matched ? winner : null,
        top_score: state.duplicateScore,
        runner_up_score: state.compareRunnerUp,
        margin: Number((state.duplicateScore - state.compareRunnerUp).toFixed(4)),
        gallery_size: body.gallery.length,
        candidates: [
          { user_id: winner, score: state.duplicateScore },
          ...body.gallery
            .filter((entry) => entry.user_id !== winner)
            .slice(0, 4)
            .map((entry) => ({ user_id: entry.user_id, score: state.compareRunnerUp })),
        ],
      };
    },

    'POST /verify/start': () => ({
      session_id: randomUUID(),
      prompt: 'Blink 2 times',
      total_steps: 2,
    }),

    'POST /verify/frame': () => {
      const settled = state.livenessOutcome !== 'in_progress';
      return {
        status: state.livenessOutcome,
        prompt: settled ? null : 'Blink 2 times',
        step_index: settled ? 2 : 0,
        total_steps: 2,
        step_progress: settled ? 1 : 0.5,
        failure_reason:
          state.livenessOutcome === 'failed' ? 'challenge_timeout' : null,
        face_detected: true,
        ready_to_match: state.livenessOutcome === 'passed',
        signals: settled ? signals() : null,
      };
    },

    'POST /verify/match': (body) => {
      const matched = state.matchDecision === 'matched';
      const topId = state.matchUserId ?? body.gallery[0]?.user_id ?? null;

      return {
        decision: state.matchDecision,
        user_id: matched ? topId : null,
        top_score: state.topScore,
        runner_up_score: state.runnerUpScore,
        margin: Number((state.topScore - state.runnerUpScore).toFixed(4)),
        gallery_size: body.gallery.length,
        candidates: body.gallery.slice(0, 5).map((entry, index) => ({
          user_id: entry.user_id,
          score: index === 0 ? state.topScore : state.runnerUpScore,
        })),
        probe_embedding_b64: embeddingB64(),
        signals: signals(),
      };
    },
  };

  const server = createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && req.url === '/health') {
      if (state.failNextRequest) {
        const { status, detail } = state.failNextRequest;
        state.failNextRequest = null;
        return send(status, { detail });
      }
      return send(200, {
        status: 'ok',
        models_loaded: state.modelsLoaded,
        active_enrollment_sessions: 0,
        active_verification_sessions: 0,
      });
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });

    req.on('end', async () => {
      const key = `${req.method} ${req.url}`;
      state.requests.push({ key, body: raw ? JSON.parse(raw) : null });

      if (state.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }

      if (state.failNextRequest) {
        const { status, detail } = state.failNextRequest;
        state.failNextRequest = null;
        return send(status, { detail });
      }

      const handler = routes[key];
      if (!handler) return send(404, { detail: `no fake route for ${key}` });

      return send(200, handler(raw ? JSON.parse(raw) : {}));
    });
  });

  return {
    state,
    reset() {
      Object.assign(state, {
        livenessOutcome: 'in_progress',
        matchDecision: 'matched',
        matchUserId: null,
        topScore: 0.82,
        runnerUpScore: 0.31,
        enrollmentAccepts: true,
        duplicateScore: 0.05,
        compareRunnerUp: 0.1,
        compareUserId: null,
        modelsLoaded: true,
        failNextRequest: null,
        delayMs: 0,
        requests: [],
      });
    },
    // Rejects rather than emitting on the server, so a port already in use
    // surfaces as a failed test with a reason instead of an unhandled 'error'
    // event and a process that never finishes starting.
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
