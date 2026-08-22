import { config } from '../config/index.js';

/**
 * Raised when the ML service answers with an error status.
 *
 * Carries the upstream status so controllers can distinguish "the caller sent
 * something wrong" from "the ML service is unwell" — those deserve different
 * responses and only one of them is worth retrying.
 */
export class MlServiceError extends Error {
  constructor(message, { status, detail, endpoint } = {}) {
    super(message);
    this.name = 'MlServiceError';
    this.status = status ?? null;
    this.detail = detail ?? null;
    this.endpoint = endpoint ?? null;

    // Derived from the normalised field, not the raw argument. A timeout
    // constructs this without a `status` at all, so testing the argument
    // compared `undefined` against `null`, decided a timeout was the caller's
    // fault, and left the handler to call res.status(null).
    this.isUpstreamFault = this.status === null || this.status >= 500;
  }
}

async function request(endpoint, body) {
  // Without a deadline a stalled ML service would hold kiosk requests open
  // until the client gave up, and the queue behind it would grow unbounded.
  const abort = AbortSignal.timeout(config.ML_SERVICE_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${config.ML_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort,
    });
  } catch (cause) {
    const reason =
      cause.name === 'TimeoutError'
        ? `timed out after ${config.ML_SERVICE_TIMEOUT_MS}ms`
        : 'is unreachable';
    throw new MlServiceError(`ML service ${reason}`, { endpoint, detail: cause.message });
  }

  if (!response.ok) {
    // FastAPI puts the human-readable reason in `detail`; a 422 carries an
    // array of validation issues instead.
    const payload = await response.json().catch(() => ({}));
    const detail =
      typeof payload.detail === 'string'
        ? payload.detail
        : JSON.stringify(payload.detail ?? payload);

    throw new MlServiceError(`ML service rejected ${endpoint}`, {
      status: response.status,
      detail,
      endpoint,
    });
  }

  return response.json();
}

export const mlService = {
  async health() {
    const response = await fetch(`${config.ML_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(config.ML_SERVICE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new MlServiceError('ML service health check failed', {
        status: response.status,
        endpoint: '/health',
      });
    }
    return response.json();
  },

  startEnrollment: () => request('/enroll/start'),

  captureEnrollmentSample: (sessionId, imageB64) =>
    request('/enroll/capture', { session_id: sessionId, image_b64: imageB64 }),

  finalizeEnrollment: (sessionId) =>
    request('/enroll/finalize', { session_id: sessionId }),

  /**
   * Match a loose embedding against a gallery, outside any session.
   *
   * Used at the end of enrollment to ask whether this face is already
   * registered. It deliberately does not go through `match`, which refuses to
   * run without a passed liveness challenge — that refusal is what guarantees
   * no spoofed frame is ever matched, and it should not be relaxed to answer a
   * different question.
   */
  compare: (embeddingB64, gallery) =>
    request('/compare', {
      embedding_b64: embeddingB64,
      gallery,
      threshold: config.MATCH_THRESHOLD ?? null,
      margin: config.MATCH_MARGIN ?? null,
    }),

  startVerification: () => request('/verify/start'),

  submitFrame: (sessionId, imageB64) =>
    request('/verify/frame', { session_id: sessionId, image_b64: imageB64 }),

  /**
   * Identify a verified face against a candidate pool.
   *
   * The pool is assembled here rather than in the ML service because the
   * database and its decryption key live on this side. The ML service is given
   * exactly the vectors it needs to compare and nothing about who they are
   * beyond an opaque id.
   */
  match: (sessionId, gallery, thresholds = {}) =>
    request('/verify/match', {
      session_id: sessionId,
      gallery,
      threshold: thresholds.threshold ?? config.MATCH_THRESHOLD ?? null,
      margin: thresholds.margin ?? config.MATCH_MARGIN ?? null,
    }),
};
