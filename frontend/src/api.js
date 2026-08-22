/**
 * Calls to the Node API.
 *
 * In development Vite proxies /api to the backend, so requests are
 * same-origin. Deployed, the two sit on different hosts and VITE_API_URL
 * points at the backend.
 */
const BASE = import.meta.env.VITE_API_URL ?? '';

class ApiError extends Error {
  constructor(message, { status, code, issues } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues ?? [];
  }
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(
      'Cannot reach the server. Check your connection and try again.',
      { code: 'network' },
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(error.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
      issues: error.issues,
    });
  }

  return payload;
}

export const api = {
  health: () => fetch(`${BASE}/health`).then((r) => r.json()),

  startEnrollment: (body) => post('/api/enroll/start', body),
  captureSample: (sessionId, image) =>
    post('/api/enroll/capture', { sessionId, image }),
  finalizeEnrollment: (sessionId) =>
    post('/api/enroll/finalize', { sessionId }),

  startVerification: (body) => post('/api/verify/start', body),
  submitFrame: (sessionId, image) =>
    post('/api/verify/frame', { sessionId, image }),
  match: (sessionId) => post('/api/verify/match', { sessionId }),
};

export { ApiError };

/** Rejection reasons from the ML service, in words a person can act on. */
const REASONS = {
  frame_too_blurry: 'Hold still — the camera caught motion',
  frame_too_dark: 'Too dark. Find brighter light',
  frame_overexposed: 'Too bright. Move away from the light behind you',
  no_face_detected: 'No face found. Centre yourself in the frame',
  multiple_faces_detected: 'More than one face in view',
  face_too_small: 'Move closer to the camera',
  low_detection_confidence: 'Face unclear. Try better lighting',
  undecodable_image: 'The frame did not come through. Trying again',
  challenge_timeout: 'Took too long — let us try that again',
  frame_budget_exceeded: 'That did not look live. Try again',
  face_lost: 'Your face left the frame',
};

export function explain(reason) {
  if (!reason) return null;
  if (reason.startsWith('no_matchable_frame')) {
    return 'Could not get a clear enough shot. Try again in better light';
  }
  return REASONS[reason] ?? reason.replaceAll('_', ' ');
}
