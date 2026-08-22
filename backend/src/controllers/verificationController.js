import { z } from 'zod';

import { config } from '../config/index.js';
import { ApiError } from '../middleware/errorHandler.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { buildCandidatePool, recordSighting } from '../services/candidatePool.js';
import { encryptEmbedding } from '../services/encryption.js';
import { mlService } from '../services/mlServiceClient.js';

// `.nullish()`, not `.optional()` — a client with nothing to send for a field
// sends `null` rather than dropping the key. See the note in
// enrollmentController for why that is worth accepting.
const startSchema = z.object({
  merchantId: z.string().trim().min(1).max(80),
  deviceId: z.string().trim().max(80).nullish(),
  region: z.string().trim().max(80).nullish(),
});

const frameSchema = z.object({
  sessionId: z.string().min(1),
  image: z.string().min(1),
});

const matchSchema = z.object({ sessionId: z.string().min(1) });

async function loadSession(sessionId) {
  const session = await Session.findOne({ _id: sessionId, kind: 'verification' });

  if (!session || session.isExpired()) {
    throw new ApiError(404, 'Session not found or expired', 'session_not_found');
  }
  return session;
}

/**
 * Write one row to the audit trail.
 *
 * Every attempt is logged, including the ones that never reached matching.
 * A liveness failure is the most interesting row in the table for fraud
 * analysis — it is what a spoof attempt looks like — so leaving those out
 * would omit exactly the data Phase 4 needs.
 */
async function writeLog(session, fields) {
  return VerificationLog.create({
    sessionId: String(session._id),
    attemptNumber: session.attempts,
    merchantId: session.merchantId,
    deviceId: session.deviceId,
    region: session.region,
    challenge: session.challenge,
    ...fields,
  });
}

function livenessFields(signals, { passed, failureReason = null } = {}) {
  if (!signals) return { passed, failureReason };

  return {
    passed,
    failureReason,
    challenge: signals.challenge ?? [],
    framesProcessed: signals.frames_processed,
    framesWithoutFace: signals.frames_without_face,
    blinksDetected: signals.blinks_detected,
    earOpenBaseline: signals.ear_open_baseline,
    earThresholdUsed: signals.ear_threshold_used,
    elapsedSeconds: signals.elapsed_seconds,
  };
}

export async function startVerification(req, res) {
  const body = startSchema.parse(req.body);
  const mlSession = await mlService.startVerification();

  const session = await Session.create({
    kind: 'verification',
    mlSessionId: mlSession.session_id,
    merchantId: body.merchantId,
    deviceId: body.deviceId ?? null,
    region: body.region ?? null,
  });

  res.status(201).json({
    sessionId: String(session._id),
    prompt: mlSession.prompt,
    totalSteps: mlSession.total_steps,
  });
}

/**
 * Feed one frame into the liveness challenge.
 *
 * Only the ML service's cheap per-frame path runs here. Recognition does not
 * happen until liveness has passed, which is what keeps a spoof attempt from
 * ever costing an embedding comparison.
 */
export async function submitFrame(req, res) {
  const body = frameSchema.parse(req.body);
  const session = await loadSession(body.sessionId);

  if (session.completed) {
    throw new ApiError(409, 'Session already completed', 'session_completed');
  }

  const result = await mlService.submitFrame(session.mlSessionId, body.image);

  if (result.signals?.challenge?.length && session.challenge.length === 0) {
    session.challenge = result.signals.challenge;
  }

  if (result.status === 'failed') {
    // Terminal. Log it and close the session — the kiosk has to start a fresh
    // challenge rather than continue feeding frames into a dead one.
    session.completed = true;
    session.attempts += 1;
    await session.save();

    await writeLog(session, {
      outcome: result.failure_reason?.startsWith('no_matchable_frame')
        ? 'capture_failed'
        : 'liveness_failed',
      liveness: livenessFields(result.signals, {
        passed: false,
        failureReason: result.failure_reason,
      }),
    });
  } else if (session.isModified()) {
    await session.save();
  }

  res.json({
    status: result.status,
    prompt: result.prompt,
    stepIndex: result.step_index,
    totalSteps: result.total_steps,
    stepProgress: result.step_progress,
    faceDetected: result.face_detected,
    readyToMatch: result.ready_to_match,
    failureReason: result.failure_reason ?? null,
  });
}

/**
 * Identify the verified face and record the outcome.
 *
 * Three outcomes are possible and they mean different things to the kiosk:
 *
 *   matched    one identity, confidently ahead of the runner-up
 *   ambiguous  two candidates too close to separate — the second factor has to
 *              resolve it, and the system must not guess
 *   no_match   nobody enrolled looks like this
 */
export async function matchFace(req, res) {
  const body = matchSchema.parse(req.body);
  const session = await loadSession(body.sessionId);

  if (session.completed) {
    throw new ApiError(409, 'Session already completed', 'session_completed');
  }
  if (session.attempts >= config.MAX_VERIFICATION_ATTEMPTS) {
    throw new ApiError(429, 'Too many attempts for this session', 'attempts_exhausted');
  }

  const startedAt = Date.now();
  session.attempts += 1;

  const { gallery, undecryptable, narrowed } = await buildCandidatePool({
    merchantId: session.merchantId,
    region: session.region,
  });

  if (undecryptable.length > 0) {
    // Not fatal — the rest of the pool is still usable — but it means either a
    // key rotation left records behind or a row was tampered with.
    console.error(
      `[verification] ${undecryptable.length} embeddings failed to decrypt`,
      undecryptable,
    );
  }

  const result = await mlService.match(session.mlSessionId, gallery);
  const matchedUser =
    result.decision === 'matched' ? await User.findById(result.user_id) : null;

  session.completed = result.decision === 'matched';
  await session.save();

  // Retained only when the attempt did not resolve to an enrolled user. This
  // is what makes it possible to spot the same unidentified face turning up
  // repeatedly across merchants — a much stronger signal than a count of
  // failures. Keeping it for a successful match would just duplicate an
  // identity already on file.
  const probeEmbedding = matchedUser
    ? null
    : encryptEmbedding(Buffer.from(result.probe_embedding_b64, 'base64'));

  const log = await writeLog(session, {
    outcome: result.decision,
    matchedUser: matchedUser?._id ?? null,
    scores: {
      top: result.top_score,
      runnerUp: result.runner_up_score,
      margin: result.margin,
    },
    gallerySize: result.gallery_size,
    candidates: result.candidates.map((c) => ({
      userId: c.user_id,
      score: c.score,
    })),
    thresholds: {
      match: config.MATCH_THRESHOLD ?? null,
      margin: config.MATCH_MARGIN ?? null,
    },
    liveness: livenessFields(result.signals, { passed: true }),
    probeEmbedding,
    processingTimeMs: Date.now() - startedAt,
  });

  if (matchedUser) {
    // Deliberately not awaited into the response path: an authorised payment
    // must not fail because a statistics update did.
    recordSighting(matchedUser._id, {
      merchantId: session.merchantId,
      region: session.region,
    }).catch((cause) =>
      console.error('[verification] failed to record sighting', cause),
    );
  }

  res.json({
    decision: result.decision,
    user: matchedUser
      ? { userId: String(matchedUser._id), displayName: matchedUser.displayName }
      : null,
    confidence: {
      top: result.top_score,
      runnerUp: result.runner_up_score,
      margin: result.margin,
    },
    gallerySize: result.gallery_size,
    poolNarrowed: narrowed,
    // Says what the kiosk should do next, so the UI does not have to encode
    // the policy itself.
    nextStep:
      result.decision === 'matched'
        ? 'second_factor'
        : result.decision === 'ambiguous'
          ? 'disambiguate'
          : 'reject',
    logId: String(log._id),
  });
}
