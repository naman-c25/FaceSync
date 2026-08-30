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

/** Ids when the gallery is resident, the vectors themselves when it is not. */
function galleryPayload(gallery, galleryId) {
  return galleryId
    ? { candidate_ids: gallery.map((entry) => entry.user_id), gallery_id: galleryId }
    : { gallery };
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
  /**
   * Hand the ML service the whole gallery to hold in memory.
   *
   * Called at boot and whenever a signature changes. Everything after this
   * sends ids rather than vectors -- see services/gallerySync.js for why.
   */
  loadGallery: (galleryId, entries) =>
    request('/gallery/load', { gallery_id: galleryId, entries }),

  galleryStatus: () => request('/gallery/status'),

  /**
   * `galleryId` present means the vectors are already resident and only ids
   * travel. Absent means ship them inline, which is what happened before the
   * resident store existed and is still the fallback when a push has failed.
   */
  compare: (embeddingB64, gallery, galleryId = null) =>
    request('/compare', {
      embedding_b64: embeddingB64,
      ...galleryPayload(gallery, galleryId),
      threshold: config.MATCH_THRESHOLD ?? null,
      margin: config.MATCH_MARGIN ?? null,
    }),

  startVerification: () => request('/verify/start'),

  /**
   * Send a batch of consecutive frames with the moments they were captured.
   *
   * Batched because the sampling rate has to be decoupled from the round trip:
   * a browser captures at 15fps and ships perhaps 4fps over a tunnel, and at
   * 4fps a 250ms blink falls between samples more often than not.
   */
  submitFrames: (sessionId, frames) =>
    request('/verify/frame', { session_id: sessionId, frames }),

  /**
   * Identify a verified face against a candidate pool.
   *
   * The pool is assembled here rather than in the ML service because the
   * database and its decryption key live on this side. The ML service is given
   * exactly the vectors it needs to compare and nothing about who they are
   * beyond an opaque id.
   */
  match: (sessionId, gallery, thresholds = {}, galleryId = null) =>
    request('/verify/match', {
      session_id: sessionId,
      ...galleryPayload(gallery, galleryId),
      threshold: thresholds.threshold ?? config.MATCH_THRESHOLD ?? null,
      margin: thresholds.margin ?? config.MATCH_MARGIN ?? null,
    }),
};
