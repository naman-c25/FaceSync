import { config } from '../config/index.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { buildCandidatePool, recordSighting } from './candidatePool.js';
import { encryptEmbedding } from './encryption.js';
import { mlService } from './mlServiceClient.js';

/**
 * Identify the face behind a verification session, and log the attempt.
 *
 * Shared by the plain kiosk flow and the merchant payment flow, which need the
 * same answer for different reasons. Keeping it in one place matters more than
 * usual here: the two-condition match rule and the audit row are the parts
 * that would quietly diverge if each caller had its own copy, and a payment
 * path that identified people by slightly different rules than the demo path
 * would be worse than either.
 *
 * The caller is responsible for what happens next — this neither charges
 * anything nor decides whether the outcome is good enough to act on.
 */
export async function identifyFromSession(session, { completeOnMatch = true } = {}) {
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
      `[identify] ${undecryptable.length} embeddings failed to decrypt`,
      undecryptable,
    );
  }

  let result = await mlService.match(session.mlSessionId, gallery);
  let widened = false;

  // Second tier. A narrowed pool that comes back empty-handed has not
  // established that this person is unenrolled — only that they are not one of
  // the locals. Rejecting there is how a customer who is registered, and has
  // simply walked into a different shop, gets told to register again.
  //
  // Only on `no_match`. An `ambiguous` result means the pool already held two
  // faces too close to separate, and adding thousands more can only make that
  // worse.
  //
  // Run through `compare` rather than `match` because the ML service discards
  // its verification session the moment it answers, so there is no second
  // match to make. The probe from the first pass is reused, which also means
  // this cannot become a way to match a face that never passed liveness.
  if (narrowed && result.decision === 'no_match') {
    const wide = await buildCandidatePool({ narrow: false });

    if (wide.gallery.length > gallery.length) {
      const second = await mlService.compare(result.probe_embedding_b64, wide.gallery);

      if (second.decision !== 'no_match') {
        result = {
          ...second,
          // `compare` knows nothing about the session that produced the probe,
          // so the liveness evidence and the probe itself carry over from the
          // first pass. Losing them would leave an audit row that could not say
          // whether a live person was ever present.
          probe_embedding_b64: result.probe_embedding_b64,
          signals: result.signals,
        };
        widened = true;
      }
    }
  }

  const matchedUser =
    result.decision === 'matched' ? await User.findById(result.user_id) : null;

  session.completed = completeOnMatch && result.decision === 'matched';
  await session.save();

  // Retained only when the attempt did not resolve to an enrolled user — what
  // makes it possible to spot the same unidentified face turning up repeatedly
  // across merchants. Keeping it for a successful match would just store a
  // second copy of an identity already on file.
  const probeEmbedding = matchedUser
    ? null
    : encryptEmbedding(Buffer.from(result.probe_embedding_b64, 'base64'));

  const log = await VerificationLog.create({
    sessionId: String(session._id),
    attemptNumber: session.attempts,
    merchantId: session.merchantId,
    deviceId: session.deviceId,
    region: session.region,
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
    liveness: livenessFields(result.signals),
    probeEmbedding,
    poolNarrowed: narrowed,
    poolWidened: widened,
    processingTimeMs: Date.now() - startedAt,
  });

  if (matchedUser) {
    // Deliberately not awaited into the response path: an authorised payment
    // must not fail because a statistics update did.
    recordSighting(matchedUser._id, {
      merchantId: session.merchantId,
      region: session.region,
    }).catch((cause) => console.error('[identify] failed to record sighting', cause));
  }

  return { result, matchedUser, log, narrowed, widened };
}

export function livenessFields(signals, { passed = true, failureReason = null } = {}) {
  if (!signals) return { passed, failureReason };

  return {
    passed,
    failureReason,
    challenge: signals.challenge ?? [],
    framesProcessed: signals.frames_processed,
    framesWithoutFace: signals.frames_without_face,
    blinksDetected: signals.blinks_detected,
    longestBlinkMs: signals.longest_blink_ms,
    // The number that separates "the threshold is wrong" from "the blink was
    // never sampled". Below about 8fps a 250ms blink falls between frames.
    effectiveFps: signals.effective_fps,
    earMin: signals.ear_min,
    earMax: signals.ear_max,
    gazeMin: signals.gaze_min,
    gazeMax: signals.gaze_max,
    yawMin: signals.yaw_min,
    yawMax: signals.yaw_max,
    earOpenBaseline: signals.ear_open_baseline,
    earThresholdUsed: signals.ear_threshold_used,
    elapsedSeconds: signals.elapsed_seconds,
    // What actually carried each look step, and which way. A rest window
    // rejected for not being still counts here too, which separates someone
    // who never settles from someone who never moves.
    baselineRetries: signals.baseline_retries ?? 0,
    stepShifts: signals.step_shifts ?? [],
    // Separates "the camera never saw a face" from "it saw two and could not
    // tell which was paying", which look identical in the outcome and need
    // opposite advice.
    framesCrowded: signals.frames_crowded ?? 0,
    passiveFrames: signals.passive_frames ?? 0,
    passiveMotionPx: signals.passive_motion_px ?? null,
    spoofAvailable: signals.spoof_available ?? false,
    spoofRealScore: signals.spoof_real_score ?? null,
    spoofLabel: signals.spoof_label ?? null,
    spoofModelsUsed: signals.spoof_models_used ?? 0,
  };
}

/** Load a live verification session, or explain why it cannot be used. */
export async function loadVerificationSession(sessionId) {
  const session = await Session.findOne({ _id: sessionId, kind: 'verification' });
  if (!session || session.isExpired()) return { error: 'session_not_found' };
  if (session.completed) return { error: 'session_completed' };
  // A session mid-payment has been identified but not finished. Its match
  // attempt is spent; only the PIN step is left, so the attempt cap does not
  // apply to it.
  if (session.identifiedUser) return { session };
  if (session.attempts >= config.MAX_VERIFICATION_ATTEMPTS) {
    return { error: 'attempts_exhausted' };
  }
  return { session };
}
