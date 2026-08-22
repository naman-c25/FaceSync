import mongoose from 'mongoose';

/**
 * An enrolled identity.
 *
 * No raw face image is ever stored — only the encrypted 512-dimension
 * embedding produced at enrollment. An embedding is not reversible into a
 * recognisable photograph, and it is encrypted at rest on top of that.
 *
 * There is deliberately no phone number or other identifier used to look
 * people up. The system identifies by face alone (1:N), so nothing here needs
 * to link a face to a contact detail, and a field that does not exist cannot
 * leak. `recoveryDigits` is the one exception and is explained below.
 */
const userSchema = new mongoose.Schema(
  {
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    // Ciphertext from services/encryption.js, not a raw vector.
    embedding: {
      type: Buffer,
      required: true,
      select: false,
    },

    // Quality of the enrollment that produced the embedding above, kept so a
    // user who matches poorly can be told to re-enrol rather than left
    // failing. A low mean similarity means the samples disagreed with each
    // other and the stored identity is a blurred average of them.
    enrollment: {
      samplesUsed: { type: Number, required: true },
      meanSimilarity: { type: Number, required: true },
      outliersDropped: { type: Number, default: 0 },
      completedAt: { type: Date, default: Date.now },
    },

    // The knowledge factor: hashed with a salt and a server-side pepper, never
    // encrypted. See services/pin.js for why hashing is the only sensible
    // choice for something nothing ever needs to read back.
    pinHash: { type: String, default: null, select: false },

    // What actually protects a four-digit PIN. Ten thousand possibilities is
    // nothing to a computer, so the hash is not the defence — the lockout is,
    // exactly as it is at a cash machine.
    pinFailures: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },

    // Last four digits of a phone number, hashed. Used only to break a tie
    // when the face match is ambiguous — never to look anyone up, and never
    // enough on its own to identify. Optional, because the zero-touch path
    // does not involve it at all.
    recoveryDigits: {
      type: String,
      select: false,
      default: null,
    },

    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      index: true,
    },

    // Where this identity came from. `benchmark` rows are faces from a public
    // research dataset, loaded to measure whether 1:N still holds at a
    // realistic gallery size — see scripts/loadBenchmark.js.
    //
    // They are deliberately *in* the candidate pool, because the whole point is
    // to make every real customer compete against thousands of other faces.
    // What they must never be is the answer: a benchmark row is not a person
    // who consented to anything, has no PIN, and cannot be charged. The guard
    // for that lives at the two places an identity turns into a consequence —
    // taking a payment, and collapsing a repeat registration.
    source: {
      type: String,
      enum: ['live', 'benchmark'],
      default: 'live',
      index: true,
    },

    // Which dataset and which person within it, kept only for benchmark rows so
    // a surprising score can be traced back to the image that produced it.
    benchmarkLabel: { type: String, default: null },

    // What the candidate pool narrows on. At demo scale every active user is a
    // candidate; as enrollment grows these keep the comparison count bounded
    // without ever asking the customer to identify themselves.
    homeRegion: { type: String, default: null, index: true },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    knownMerchants: { type: [String], default: [], index: true },
  },
  {
    timestamps: true,
    // Embeddings must not escape through a stray res.json(user).
    toJSON: {
      transform(_doc, ret) {
        delete ret.embedding;
        delete ret.recoveryDigits;
        delete ret.pinHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Enrollments are re-taken periodically, so the natural query is "active users
// in this region seen recently" — which this covers in one index.
userSchema.index({ status: 1, homeRegion: 1, lastSeenAt: -1 });

export const User = mongoose.model('User', userSchema);
