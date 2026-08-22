import mongoose from 'mongoose';

/**
 * One payment attempt at a terminal.
 *
 * Separate from `VerificationLog` on purpose. That table answers "how well does
 * the biometric perform" and holds every attempt including the ones that never
 * identified anyone; this one answers "what was charged, to whom, by which
 * shop". Merging them would mean the accounting view is full of rows with no
 * amount, and the FAR/FRR view is full of rows about money.
 *
 * They are linked by `verificationLog`, so one can always be read from the
 * other.
 */
const transactionSchema = new mongoose.Schema(
  {
    merchantId: { type: String, required: true, index: true },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Paise, as Razorpay counts. Kept in the smallest unit deliberately —
    // storing rupees as a float invites the usual rounding errors, and this is
    // money.
    amountPaise: { type: Number, required: true, min: 100 },
    currency: { type: String, default: 'INR' },

    razorpayOrderId: { type: String, default: null, index: true },

    status: {
      type: String,
      required: true,
      enum: [
        // Face identified and the order exists at Razorpay. This is as far as
        // a test-mode integration can honestly go: settling it needs a
        // registered UPI Autopay mandate, which needs merchant KYC.
        'authorized',
        'captured',
        'failed',
      ],
      default: 'authorized',
      index: true,
    },

    // How the customer proved it was them. Recorded per transaction rather
    // than assumed, so the audit trail says what actually happened rather than
    // what the flow is supposed to do.
    authFactors: {
      type: [String],
      default: [],
      // 'face' | 'pin' | 'voice'
    },

    // The biometric attempt this payment rests on.
    verificationLog: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VerificationLog',
      default: null,
    },
    matchScore: { type: Number, default: null },

    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);

// The merchant panel's only query: this shop's transactions, newest first.
transactionSchema.index({ merchantId: 1, createdAt: -1 });

// And the one a customer portal would ask for.
transactionSchema.index({ user: 1, createdAt: -1 });

export const Transaction = mongoose.model('Transaction', transactionSchema);
