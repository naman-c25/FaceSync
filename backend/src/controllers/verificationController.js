import { z } from 'zod';

import { config } from '../config/index.js';
import { ApiError } from '../middleware/errorHandler.js';
import { User } from '../models/User.js';
import { checkPinAttempt } from '../services/pin.js';
import { Session } from '../models/Session.js';
import { Merchant } from '../models/Merchant.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { evaluate } from '../services/fraudRuleEngine.js';
import {
  identifyFromSession,
  livenessFields,
  loadVerificationSession,
} from '../services/identification.js';
import { mlService } from '../services/mlServiceClient.js';

// `.nullish()`, not `.optional()` — a client with nothing to send for a field
// sends `null` rather than dropping the key. See the note in
// enrollmentController for why that is worth accepting.
// No `merchantId`. Which shop a session belongs to is decided by the server:
// the kiosk's is a constant and a till's comes from its token. Accepting it
// from the body is what let an unapproved terminal borrow an approved shop's
// id and scan customers anyway.
const startSchema = z.object({
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
  const log = await VerificationLog.create({
    sessionId: String(session._id),
    attemptNumber: session.attempts,
    merchantId: session.merchantId,
    deviceId: session.deviceId,
    region: session.region,
    challenge: session.challenge,
    ...fields,
  });

  // Checked here rather than on a schedule: the trigger for a fraud rule is
  // "a row was just written", and this is where that happens. `evaluate`
  // never throws -- a heuristic must not be able to fail a payment.
  await evaluate(log);

  return log;
}

/**
 * Open a scanning session.
 *
 * Two entry points reach this, and neither lets the caller say which shop it
 * is for. The public kiosk (unauthenticated) is always booked to the kiosk's
 * own id; a till (behind `requireMerchant`) is booked to the shop in its token
 * and only if that shop has been approved.
 *
 * That split is the whole point. When this read `merchantId` from the request
 * body, the approval check asked the caller which identity to check them
 * against — an unapproved shop simply sent the kiosk's id instead and scanned
 * customers anyway, learning the name of anyone who looked at its camera. The
 * rule the rest of the codebase already follows, in `requireMerchant`: a
 * merchant id from a request body is a value the caller chose, not an identity.
 */
async function openSession(req, res, merchantId) {
  const body = startSchema.parse(req.body);

  const mlSession = await mlService.startVerification();

  const session = await Session.create({
    kind: 'verification',
    mlSessionId: mlSession.session_id,
    merchantId,
    deviceId: body.deviceId ?? null,
    region: body.region ?? null,
  });

  res.status(201).json({
    sessionId: String(session._id),
    prompt: mlSession.prompt,
    totalSteps: mlSession.total_steps,
  });
}

/** The public kiosk. Always the kiosk's own shop id, whatever was sent. */
export async function startVerification(req, res) {
  return openSession(req, res, config.KIOSK_MERCHANT_ID);
}

/** A till. Behind `requireMerchant`, so the shop comes from the token. */
export async function startMerchantVerification(req, res) {
  const shop = await Merchant.findOne({
    merchantId: req.merchant.merchantId,
  }).select('verified active');

  if (!shop?.active) {
    throw new ApiError(401, 'Session is no longer valid', 'invalid_session');
  }

  // A shop that signed up for itself cannot look at a customer until it has
  // been approved. Gated here rather than at the charge, because being told a
  // stranger's name is the thing an unapproved terminal must not be able to
  // do -- taking money already needs that customer's own PIN.
  if (!shop.verified) {
    throw new ApiError(
      403,
      'This terminal is waiting to be approved, so it cannot scan yet',
      'terminal_not_verified',
    );
  }

  // From the token rather than the row just read: it is the identity the
  // request actually authenticated as, and the projection above does not
  // even include the field.
  return openSession(req, res, req.merchant.merchantId);
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

  // Held open rather than completed, because a match is only the first factor.
  // The kiosk asks for a PIN next and `confirmPin` needs the session to still
  // know who was identified -- the ML service discards its own the moment it
  // answers, so there is no second match to make.
  const { result, matchedUser, narrowed, log } = await identifyFromSession(session, {
    completeOnMatch: false,
  });

  if (matchedUser) {
    session.identifiedUser = matchedUser._id;
    session.identifiedLog = log._id;
    session.matchScore = result.top_score;
    session.runnerUpScore = result.runner_up_score;
    session.gallerySize = result.gallery_size;
    await session.save();
  }
  // A miss deliberately leaves the session open. The attempt cap in
  // `loadVerificationSession` governs how many tries one scan gets, and
  // closing it here would take away the retry a customer who was simply badly
  // lit is entitled to.

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

const confirmSchema = z.object({
  sessionId: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/, 'A PIN must be exactly four digits'),
});

/**
 * The second factor, at the customer kiosk.
 *
 * The face said who; this is how they approve. Without it the kiosk would be
 * single-factor while the till is two, and the same person would be held to
 * different standards depending on which screen they happened to be in front
 * of — which is worse than either rule on its own.
 *
 * The PIN policy itself lives in `services/pin.js` rather than here, so that
 * this path and the payment path cannot drift apart on the one thing that
 * actually protects four digits: the lockout.
 */
export async function confirmPin(req, res) {
  const body = confirmSchema.parse(req.body);
  const { session, error } = await loadVerificationSession(body.sessionId);

  if (error) {
    const [status, message] = {
      session_not_found: [404, 'Session not found or expired'],
      session_completed: [409, 'Session already completed'],
      attempts_exhausted: [429, 'Too many attempts for this session'],
    }[error];
    throw new ApiError(status, message, error);
  }

  if (!session.identifiedUser) {
    throw new ApiError(
      409,
      'This scan has not identified anyone yet',
      'not_identified',
    );
  }

  const user = await User.findById(session.identifiedUser);
  const check = await checkPinAttempt(user, body.pin);

  if (!check.ok) {
    // A wrong PIN with tries left keeps the session, so the person can try
    // again without standing through another scan. A lockout ends it.
    if (check.outcome === 'locked' || check.outcome === 'no_pin_set') {
      session.completed = true;
      await session.save();
    }

    // Logged as its own row. A refusal used to leave no trace at all, which
    // meant somebody working through PINs against a face they had already got
    // recognised produced an audit trail showing one successful match and
    // nothing else. Success needs no second row -- the matched row and the
    // transaction record between them already say it completed.
    await writeLog(session, {
      outcome: 'pin_failed',
      pinOutcome: check.outcome,
      matchedUser: session.identifiedUser,
      scores: { top: session.matchScore, runnerUp: session.runnerUpScore },
      gallerySize: session.gallerySize,
    });

    // 200 deliberately: a refused PIN is an outcome, not a failed request, and
    // an error-shaped body would lose the reason the kiosk needs to show.
    return res.json({
      confirmed: false,
      pinOutcome: check.outcome,
      attemptsLeft: check.attemptsLeft,
      reason: check.reason,
      user: { userId: String(user._id), displayName: user.displayName },
    });
  }

  session.completed = true;
  await session.save();

  res.json({
    confirmed: true,
    user: { userId: String(user._id), displayName: user.displayName },
    confidence: {
      top: session.matchScore,
      runnerUp: session.runnerUpScore,
    },
    gallerySize: session.gallerySize,
  });
}
