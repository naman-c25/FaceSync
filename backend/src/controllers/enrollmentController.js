import { z } from 'zod';

import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { encryptEmbedding } from '../services/encryption.js';
import { mlService } from '../services/mlServiceClient.js';
import { ApiError } from '../middleware/errorHandler.js';

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

  const result = await mlService.finalizeEnrollment(session.mlSessionId);
  const embedding = Buffer.from(result.embedding_b64, 'base64');

  const user = await User.create({
    displayName: session.displayName,
    embedding: encryptEmbedding(embedding),
    enrollment: {
      samplesUsed: result.samples_used,
      meanSimilarity: result.mean_similarity,
      outliersDropped: result.outliers_dropped,
    },
    homeRegion: session.region,
    knownMerchants: session.merchantId ? [session.merchantId] : [],
    recoveryDigits: body.recoveryDigits ?? null,
  });

  session.completed = true;
  await session.save();

  res.status(201).json({
    userId: String(user._id),
    displayName: user.displayName,
    enrollment: {
      samplesUsed: result.samples_used,
      meanSimilarity: result.mean_similarity,
      outliersDropped: result.outliers_dropped,
      perSampleSimilarity: result.per_sample_similarity,
    },
  });
}
