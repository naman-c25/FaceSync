import { z } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';
import { Session } from '../models/Session.js';
import { VerificationLog } from '../models/VerificationLog.js';
import {
  identifyFromSession,
  livenessFields,
  loadVerificationSession,
} from '../services/identification.js';
import { mlService } from '../services/mlServiceClient.js';

// `.nullish()`, not `.optional()` — a client with nothing to send for a field
// sends `null` rather than dropping the key. See the note in
// enrollmentController for why that is worth accepting.
const startSchema = z.object({
  merchantId: z.string().trim().min(1).max(80),
  deviceId: z.string().trim().max(80).nullish(),
  region: z.string().trim().max(80).nullish(),
});

// Frames arrive in batches, each carrying the moment it was taken. The
// sampling rate has to be decoupled from the round trip: a browser captures at
// 15fps and ships maybe 4fps over a tunnel, and at 4fps a 250ms blink falls
// between samples more often than not — which is why gaze challenges were
// passing on connections where blink challenges failed.
const frameSchema = z.object({
  sessionId: z.string().min(1),
  frames: z
    .array(
      z.object({
        image: z.string().min(1),
        capturedAtMs: z.number().finite(),
      }),
    )
    .min(1)
    .max(12),
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

  const result = await mlService.submitFrames(
    session.mlSessionId,
    body.frames.map((f) => ({
      image_b64: f.image,
      captured_at_ms: f.capturedAtMs,
    })),
  );

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
  const { session, error } = await loadVerificationSession(body.sessionId);

  if (error) {
    const [status, message] = {
      session_not_found: [404, 'Session not found or expired'],
      session_completed: [409, 'Session already completed'],
      attempts_exhausted: [429, 'Too many attempts for this session'],
    }[error];
    throw new ApiError(status, message, error);
  }

  const { result, matchedUser, narrowed, log } = await identifyFromSession(session);

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
