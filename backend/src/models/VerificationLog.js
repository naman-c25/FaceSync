import mongoose from 'mongoose';

/**
 * One row per verification attempt, successful or not.
 *
 * This is the audit trail, and it is also the entire dataset Phase 4's fraud
 * detection will run on. Anything not recorded here is unrecoverable later, so
 * the schema errs toward keeping more than is needed today — a field that goes
 * unused costs a few bytes, while a missing one costs a re-run of every test
 * session.
 *
 * Two things here are easy to leave out and expensive to add back:
 *
 * - `thresholds` records the values that produced this decision. Without them
 *   an old log cannot be reinterpreted after tuning, because there is no way
 *   to know whether a rejection was marginal or emphatic under the settings in
 *   force at the time.
 * - `probeEmbedding` is retained on failures. It is what allows the same
 *   unidentified face to be recognised turning up repeatedly across merchants,
 *   which is a far stronger fraud signal than a count of failed attempts.
 */
const verificationLogSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    attemptNumber: { type: Number, default: 1 },

    merchantId: { type: String, required: true, index: true },
    deviceId: { type: String, default: null },
    region: { type: String, default: null },

    outcome: {
      type: String,
      required: true,
      enum: [
        'matched',
        'no_match',
        'ambiguous',
        'liveness_failed',
        'capture_failed',
        'error',
      ],
      index: true,
    },

    matchedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    // Both scores, always. The runner-up is what distinguishes a confident
    // match from a coin flip, and FAR/FRR curves cannot be drawn without it.
    scores: {
      top: { type: Number, default: null },
      runnerUp: { type: Number, default: null },
      margin: { type: Number, default: null },
    },

    gallerySize: { type: Number, default: null },
    candidates: {
      type: [{ userId: String, score: Number, _id: false }],
      default: [],
    },

    thresholds: {
      match: { type: Number, default: null },
      margin: { type: Number, default: null },
    },

    liveness: {
      passed: { type: Boolean, default: false },
      failureReason: { type: String, default: null },
      challenge: { type: [String], default: [] },
      framesProcessed: { type: Number, default: null },
      framesWithoutFace: { type: Number, default: null },
      blinksDetected: { type: Number, default: null },
      longestBlinkMs: { type: Number, default: null },
      // Frames per second actually sampled. A blink challenge that failed at
      // 3fps failed because it was undersampled, not because a threshold is
      // wrong — without this the two are indistinguishable in the log.
      effectiveFps: { type: Number, default: null },
      // The measured extremes, not just the threshold that was applied. Without
      // the floor a blink actually reached there is no way to tell a threshold
      // that was set too low from a blink that was never sampled - and tuning
      // one when the problem is the other makes things worse.
      earMin: { type: Number, default: null },
      earMax: { type: Number, default: null },
      gazeMin: { type: Number, default: null },
      gazeMax: { type: Number, default: null },
      yawMin: { type: Number, default: null },
      yawMax: { type: Number, default: null },
      earOpenBaseline: { type: Number, default: null },
      earThresholdUsed: { type: Number, default: null },
      elapsedSeconds: { type: Number, default: null },
    },

    // Encrypted, and only present on attempts that did not resolve to a user.
    // Keeping it for a successful match would mean storing a second copy of an
    // identity that is already enrolled, for no benefit.
    probeEmbedding: { type: Buffer, default: null, select: false },

    // Whether the narrowed candidate pool answered, or the search had to widen
    // to the whole gallery to find this person. A rising share of widened
    // matches means the narrowing rule is excluding people it should not, and
    // without this the only symptom would be customers being told to register
    // again by a system they are already registered with.
    poolNarrowed: { type: Boolean, default: false },
    poolWidened: { type: Boolean, default: false },

    processingTimeMs: { type: Number, default: null },
    error: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.probeEmbedding;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Phase 4's queries are all "what happened recently, here" or "what happened
// recently, to this user" — velocity checks, retry bursts, impossible travel.
verificationLogSchema.index({ merchantId: 1, createdAt: -1 });
verificationLogSchema.index({ matchedUser: 1, createdAt: -1 });
verificationLogSchema.index({ outcome: 1, createdAt: -1 });

export const VerificationLog = mongoose.model(
  'VerificationLog',
  verificationLogSchema,
);
