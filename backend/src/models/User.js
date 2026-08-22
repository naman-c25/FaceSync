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
