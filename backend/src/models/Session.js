import mongoose from 'mongoose';

import { config } from '../config/index.js';

/**
 * Short-lived state for an enrollment or verification in progress.
 *
 * The design doc puts this in Redis. It is in MongoDB with a TTL index
 * instead, which gives the same automatic expiry without a second service to
 * install and keep running during a demo — and the connection is already open.
 *
 * The tradeoff is real and worth naming: Redis would handle far more
 * concurrent sessions and expires keys promptly, while MongoDB's TTL monitor
 * sweeps about once a minute, so a record can outlive its `expiresAt` by up to
 * that long. Nothing here depends on prompt deletion — every read checks
 * `expiresAt` itself — so the lag is invisible. At kiosk volumes the
 * difference does not show up.
 */
const sessionSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: ['enrollment', 'verification'],
    },

    // The ML service runs its own session for the frame-by-frame state. This
    // is the handle for it; the two are kept separate because the ML service
    // has no business knowing about merchants or transactions.
    mlSessionId: { type: String, required: true, index: true },

    merchantId: { type: String, default: null },
    deviceId: { type: String, default: null },
    region: { type: String, default: null },

    // Enrollment only.
    displayName: { type: String, default: null },
    samplesCollected: { type: Number, default: 0 },

    // Verification only. Capped so one face cannot be retried indefinitely
    // against the margin rule.
    attempts: { type: Number, default: 0 },

    challenge: { type: [String], default: [] },
    completed: { type: Boolean, default: false },

    // Who the face turned out to be, held between the two calls a payment
    // takes. The till cannot prompt for a PIN until it knows whose to ask for,
    // and the ML service discards its own session the moment it answers a
    // match — so re-identifying on the second call is not an option.
    identifiedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    identifiedLog: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VerificationLog',
      default: null,
    },
    matchScore: { type: Number, default: null },
    runnerUpScore: { type: Number, default: null },
    gallerySize: { type: Number, default: null },

    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000),
    },
  },
  { timestamps: true },
);

// MongoDB deletes these on its own once expiresAt passes.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

sessionSchema.methods.isExpired = function isExpired() {
  return this.expiresAt.getTime() <= Date.now();
};

export const Session = mongoose.model('Session', sessionSchema);
