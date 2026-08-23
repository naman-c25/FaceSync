import { z } from 'zod';

import { config } from '../config/index.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { buildCandidatePool } from '../services/candidatePool.js';
import { encryptEmbedding } from '../services/encryption.js';
import { hashPin, rejectWeakPin } from '../services/pin.js';
import { mlService } from '../services/mlServiceClient.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Similarity above which a new enrollment is treated as someone already on
 * file. Set to the ordinary match threshold rather than something stricter: if
 * this face would match an existing user at a kiosk, it *is* a duplicate, and
 * storing it separately is what creates the ambiguity.
 */
const DUPLICATE_THRESHOLD = config.MATCH_THRESHOLD ?? 0.45;

// `.nullish()` rather than `.optional()` on every optional field. A JSON
// client that has nothing to send for a field naturally sends `null` rather
// than omitting the key — hand-written clients do it, and so does anything
// serialising a struct with empty members. Rejecting that is pedantry, and it
// produces a validation error that reads as though the request were malformed.
const startSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  region: z.string().trim().max(80).nullish(),
  merchantId: z.string().trim().max(80).nullish(),
});

const captureSchema = z.object({
  sessionId: z.string().min(1),
  image: z.string().min(1),
});

const finalizeSchema = z.object({
  sessionId: z.string().min(1),
  recoveryDigits: z
    .string()
    .regex(/^\d{4}$/, 'recoveryDigits must be exactly 4 digits')
    .nullish(),

  // The knowledge factor, and required. It was optional while enrollment was
  // mostly a way to collect faces for the dataset, but that left people
  // registered and unable to pay — a state with nothing to recommend it in a
  // payment system, and one the customer only discovers at a till with someone
  // waiting behind them.
  //
  // Enforced here rather than only in the kiosk, because the kiosk is not the
  // only thing that can call this.
  pin: z
    .string()
    .regex(/^\d{4}$/, 'A PIN must be exactly four digits'),
});

async function loadSession(sessionId, kind) {
  const session = await Session.findOne({ _id: sessionId, kind });

  if (!session || session.isExpired()) {
    // MongoDB's TTL sweep runs about once a minute, so an expired record can
    // still be present. Treating it as absent keeps the API honest regardless.
    throw new ApiError(404, 'Session not found or expired', 'session_not_found');
  }
  if (session.completed) {
    throw new ApiError(409, 'Session already completed', 'session_completed');
  }
  return session;
}

export async function startEnrollment(req, res) {
  const body = startSchema.parse(req.body);
  const mlSession = await mlService.startEnrollment();

  const session = await Session.create({
    kind: 'enrollment',
    mlSessionId: mlSession.session_id,
    displayName: body.displayName,
    region: body.region ?? null,
    merchantId: body.merchantId ?? null,
  });

  res.status(201).json({
    sessionId: String(session._id),
    samplesRequired: mlSession.samples_required,
    guidance: mlSession.guidance,
  });
}

/**
 * Take one enrollment frame.
 *
 * Rejections are returned as 200 with `accepted: false` rather than as errors.
 * A blurry frame is an expected part of the flow — the kiosk should show the
 * reason and keep capturing, not treat it as a failure and start over.
 */
export async function captureSample(req, res) {
  const body = captureSchema.parse(req.body);
  const session = await loadSession(body.sessionId, 'enrollment');

  const result = await mlService.captureEnrollmentSample(
    session.mlSessionId,
    body.image,
  );

  session.samplesCollected = result.samples_collected;
  await session.save();

  res.json({
    accepted: result.accepted,
    samplesCollected: result.samples_collected,
    samplesRequired: result.samples_required,
    reason: result.reason ?? null,
    quality: {
      sharpness: result.sharpness ?? null,
      detectionScore: result.detection_score ?? null,
    },
  });
}

/**
 * Fuse the collected samples and store the resulting identity.
 *
 * The embedding is encrypted here rather than in the ML service because this
 * is the only layer that holds the key. The ML service never sees it and never
 * touches the database.
 */
export async function finalizeEnrollment(req, res) {
  const body = finalizeSchema.parse(req.body);
  const session = await loadSession(body.sessionId, 'enrollment');

  // Checked before anything is written, so a weak PIN does not leave a
  // half-finished registration behind.
  const weak = rejectWeakPin(body.pin);
  if (weak) throw new ApiError(400, weak, 'weak_pin');

  const result = await mlService.finalizeEnrollment(session.mlSessionId);
  const embedding = Buffer.from(result.embedding_b64, 'base64');

  const existing = await findExistingRegistration(result.embedding_b64);

  const enrollment = {
    samplesUsed: result.samples_used,
    meanSimilarity: result.mean_similarity,
    outliersDropped: result.outliers_dropped,
    completedAt: new Date(),
  };

  // Registering the same face twice must update the existing record, not add
  // a second one. Two near-identical entries sit well inside the match margin
  // of each other, so from then on every attempt by that person comes back
  // ambiguous — one accidental re-enrollment locks them out permanently.
  // The name on an existing record is deliberately left alone. Someone who
  // registers a face that is already on file gets that record's face data
  // refreshed — which is the useful part of registering again — but cannot
  // rename it. Overwriting would mean anyone able to present your face could
  // silently relabel your account, and it would quietly hide the case worth
  // seeing: the same face arriving under a second name.
  const user = existing
    ? await User.findByIdAndUpdate(
        existing.userId,
        {
          $set: {
            embedding: encryptEmbedding(embedding),
            enrollment,
            lastSeenAt: new Date(),
            ...(session.region ? { homeRegion: session.region } : {}),
            // A returning face always sets a PIN now, replacing whatever was
            // there. That is also the route back for the people who enrolled
            // while it was optional: register again and you leave with one.
            pinHash: hashPin(body.pin),
            pinFailures: 0,
            pinLockedUntil: null,
          },
        },
        { new: true },
      )
    : await User.create({
        displayName: session.displayName,
        embedding: encryptEmbedding(embedding),
        enrollment,
        homeRegion: session.region,
        knownMerchants: session.merchantId ? [session.merchantId] : [],
        recoveryDigits: body.recoveryDigits ?? null,
        pinHash: hashPin(body.pin),
      });

  session.completed = true;
  await session.save();

  const nameGiven = session.displayName;
  const nameOnFile = user.displayName;

  res.status(201).json({
    userId: String(user._id),
    displayName: nameOnFile,
    // The kiosk shows something different for a returning face, and the caller
    // should not have to infer which happened from the status code.
    updatedExisting: Boolean(existing),
    // Whether this identity can complete a payment, which needs both factors.
    // Always true now that a PIN is required, and kept so a caller does not
    // have to know that to answer the question.
    hasPin: true,
    matchedScore: existing?.score ?? null,
    // True when the same face came back under a different name. Worth calling
    // out on screen: from the person's side it looks like a failed
    // registration unless they are told the face was already known.
    nameDiffers: Boolean(existing) && nameGiven !== nameOnFile,
    nameGiven,
    enrollment: {
      samplesUsed: result.samples_used,
      meanSimilarity: result.mean_similarity,
      outliersDropped: result.outliers_dropped,
      perSampleSimilarity: result.per_sample_similarity,
    },
  });
}

/**
 * Find the user this face is already registered as, if any.
 *
 * Checked against the top score rather than the decision. `identify` returns
 * `ambiguous` when the best two candidates are close — and if someone has
 * already been enrolled twice, that is precisely what happens. Reading the
 * decision would mean the one case that most needs collapsing is the one case
 * that slips through.
 */
async function findExistingRegistration(embeddingB64) {
  // No merchant or region: a duplicate has to be found wherever it was
  // registered, not just among faces local to this terminal.
  const { gallery } = await buildCandidatePool({});
  if (gallery.length === 0) return null;

  const comparison = await mlService.compare(embeddingB64, gallery);

  const close = comparison.candidates.filter((c) => c.score >= DUPLICATE_THRESHOLD);
  if (close.length === 0) return null;

  // Benchmark rows are in the pool so that a real face has to out-score
  // thousands of others, but they are not registrations and this face cannot
  // be a repeat of one. Merging into one would be the worst outcome available:
  // a real person's identity written onto a research record, and every later
  // payment of theirs refused as a benchmark match.
  const sources = await User.find({ _id: { $in: close.map((c) => c.user_id) } })
    .select('source benchmarkLabel')
    .lean();
  const byId = new Map(sources.map((u) => [String(u._id), u]));

  const benchmarkHit = close.find((c) => byId.get(c.user_id)?.source === 'benchmark');
  if (benchmarkHit) {
    // Not fatal to this enrollment, but it is a false match at the exact
    // threshold duplicates are collapsed on, and it should never be silent.
    console.warn(
      `[enroll] new face scored ${benchmarkHit.score} against benchmark row ` +
        `${benchmarkHit.user_id} (${byId.get(benchmarkHit.user_id)?.benchmarkLabel})`,
    );
  }

  const duplicate = close.find((c) => byId.get(c.user_id)?.source !== 'benchmark');
  if (!duplicate) return null;

  return { userId: duplicate.user_id, score: duplicate.score };
}
