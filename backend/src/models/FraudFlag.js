import mongoose from 'mongoose';

/**
 * One suspicious pattern, raised by a rule and waiting for a human.
 *
 * A flag is an *incident*, not an alert. Rules fire on a rolling window, so
 * once a terminal is over the threshold every further attempt fires again.
 * Replayed over the real log, the spoof rule fires 9 times for what a person
 * would describe as 5 separate episodes — and that ratio only grows with the
 * length of an attack. Rows describing one event are not a dashboard, they are
 * noise that hides the next real thing. So a rule that fires while an open flag
 * for the same rule and terminal is still inside its window extends that flag
 * instead of raising another.
 *
 * `evidence` holds the VerificationLog ids the rule counted, so a reviewer can
 * read the actual attempts rather than trusting the number. Nothing here
 * duplicates the log — it points at it.
 */
const fraudFlagSchema = new mongoose.Schema(
  {
    rule: {
      type: String,
      required: true,
      enum: ['pin_velocity', 'liveness_velocity', 'spoof_burst'],
      index: true,
    },

    // What a reviewer should do about it, not how certain the rule is.
    severity: {
      type: String,
      required: true,
      enum: ['review', 'suspicious', 'high_risk'],
    },

    // The terminal the pattern happened at. Rules are scoped to one device
    // because "five failures at this counter" is a signal and "five failures
    // across every kiosk" is a traffic report.
    deviceId: { type: String, required: true },
    merchantId: { type: String, default: null },

    // Set only where the rule could honestly attribute the pattern to somebody
    // — which is the PIN rule and nothing else. Liveness fails before
    // identification runs, so those attempts have no identity attached, and
    // inventing one by storing embeddings from failed attempts was a trade we
    // chose not to make.
    matchedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    count: { type: Number, required: true },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },

    evidence: [{ type: mongoose.Schema.Types.ObjectId, ref: 'VerificationLog' }],

    status: {
      type: String,
      enum: ['open', 'cleared', 'confirmed'],
      default: 'open',
      index: true,
    },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    note: { type: String, default: null },
  },
  { timestamps: true },
);

// The dashboard's default view: everything open, newest first.
fraudFlagSchema.index({ status: 1, createdAt: -1 });
// The suppression lookup, run on every rule that fires.
fraudFlagSchema.index({ rule: 1, deviceId: 1, status: 1, windowEnd: -1 });

export const FraudFlag = mongoose.model('FraudFlag', fraudFlagSchema);
