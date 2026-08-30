import mongoose from 'mongoose';

/**
 * One row per verification attempt, successful or not.
 *
 * This is the audit trail, and the only record of what the system decided. Anything not recorded here is unrecoverable later, so
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
 *   which is a far stronger signal than a count of failed attempts.
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
        // A face that was recognised and then refused at the PIN. Its own
        // outcome rather than a flag on the matched row, because velocity
        // rules count rows in a window and a brute-force attempt is several
        // attempts against one identification -- which only shows up as
        // several rows.
        'pin_failed',
        'error',
      ],
      index: true,
    },

    // How the PIN step ended, on the rows that reached it. Null everywhere
    // else. Kept because a wrong PIN was, until this existed, completely
    // invisible: the identification was logged and the refusal was not, so the
    // audit trail showed a successful match and then silence.
    pinOutcome: {
      type: String,
      enum: ['wrong_pin', 'locked', 'no_pin_set', null],
      default: null,
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
      // Per-step evidence for look challenges. The ranges above say how far
      // the head moved, but not from where, nor which way relative to what was
      // asked -- which is why a wrong-direction pass could only be reasoned
      // about, and the reasoning was confidently wrong before it was right.
      // `baselineRetries` counts rest windows rejected for not being still,
      // separating someone who never settles from someone who never moves.
      baselineRetries: { type: Number, default: 0 },
      stepShifts: { type: mongoose.Schema.Types.Mixed, default: [] },

      // Passive-mode evidence, and the crowding count. Without these a
      // passive session that failed is indistinguishable from one that never
      // saw a face: `framesCrowded` says two faces were in shot and neither
      // dominated, `passiveMotionPx` says whether the frames were a live
      // capture or one image repeated.
      framesCrowded: { type: Number, default: 0 },
      passiveFrames: { type: Number, default: 0 },
      passiveMotionPx: { type: Number, default: null },

      // The anti-spoof verdict on the frame the payment rested on, recorded
      // whether or not it changed the outcome. A near-miss nobody wrote down
      // is invisible until the day it matters, and this is the record the
      // threshold gets tuned against.
      //
      // `spoofAvailable` false means the models could not be given the crop
      // they were trained on, which is neither a pass nor a fail. Reading it
      // as either would be inventing a verdict.
      spoofAvailable: { type: Boolean, default: false },
      spoofRealScore: { type: Number, default: null },
      spoofLabel: { type: String, default: null },
      spoofModelsUsed: { type: Number, default: 0 },
      spoofCropScale: { type: Number, default: null },

      // Similarity between an early frame and a late one. Null when the
      // session was too short to hold two distinct moments. Recorded on every
      // attempt, since what makes the threshold movable later is a record of
      // what genuine sessions actually score.
      continuityScore: { type: Number, default: null },
      // Sharpness of the frame that would have been matched, against a
      // threshold of 45. Without it a `frame_too_blurry` refusal says only
      // that something was below the line, not how far -- which is the
      // difference between a threshold to loosen and a camera to move.
      bestFrameSharpness: { type: Number, default: null },
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
// Answers "what else happened at this terminal recently", which is the shape
// every later analysis of this table wants. Without it that is a collection
// scan on the hot path of every log write.
verificationLogSchema.index({ deviceId: 1, createdAt: -1 });

export const VerificationLog = mongoose.model(
  'VerificationLog',
  verificationLogSchema,
);
