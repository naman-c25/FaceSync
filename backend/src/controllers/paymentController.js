import { z } from 'zod';

import { config } from '../config/index.js';
import { ApiError } from '../middleware/errorHandler.js';
import { Transaction } from '../models/Transaction.js';
import {
  identifyFromSession,
  loadVerificationSession,
} from '../services/identification.js';
import { createOrder, RazorpayError } from '../services/razorpay.js';

const chargeSchema = z.object({
  sessionId: z.string().min(1),
  // Rupees at the till, converted to paise below. Capped so a typo cannot
  // create an order for a fortune during a demo.
  amount: z.number().positive().max(100000),
});

const ERRORS = {
  session_not_found: [404, 'Scan session not found or expired'],
  session_completed: [409, 'That scan has already been used'],
  attempts_exhausted: [429, 'Too many attempts on this scan'],
};

/**
 * Charge an identified customer.
 *
 * The face match and the order are one step on purpose. Splitting them would
 * leave a window in which a scan has identified someone and any subsequent
 * call could attach any amount to it — the amount has to be part of what was
 * authorised, not something added afterwards.
 *
 * How far this can honestly go: Razorpay's server-to-server payment endpoints
 * are not enabled on a test account, so an order cannot be settled without a
 * customer interacting with a checkout on some device — which is the device
 * this system exists to do without. In production the face match authorises a
 * debit against a UPI Autopay mandate registered at enrollment. The order
 * created here is real and is what such a debit would be raised against.
 */
export async function charge(req, res) {
  const body = chargeSchema.parse(req.body);
  const { session, error } = await loadVerificationSession(body.sessionId);

  if (error) throw new ApiError(...ERRORS[error], error);

  // The merchant comes from the signed token, never the request body. Taking
  // it from the caller would let any terminal book takings to another shop.
  if (session.merchantId !== req.merchant.merchantId) {
    throw new ApiError(403, 'That scan belongs to another terminal', 'wrong_merchant');
  }

  const { result, matchedUser, log } = await identifyFromSession(session);

  if (!matchedUser) {
    // No charge, but the attempt is already in the audit trail.
    return res.json({
      charged: false,
      decision: result.decision,
      reason:
        result.decision === 'ambiguous'
          ? 'Two enrolled faces scored too close to tell apart'
          : 'No enrolled customer matched',
      confidence: {
        top: result.top_score,
        runnerUp: result.runner_up_score,
        margin: result.margin,
      },
      gallerySize: result.gallery_size,
      logId: String(log._id),
    });
  }

  const amountPaise = Math.round(body.amount * 100);

  const transaction = await Transaction.create({
    merchantId: req.merchant.merchantId,
    user: matchedUser._id,
    amountPaise,
    // Face only, for now. The dial PIN will add a second entry here, and
    // recording what actually happened per transaction — rather than assuming
    // the flow — is what keeps the audit trail honest as factors are added.
    authFactors: ['face'],
    verificationLog: log._id,
    matchScore: result.top_score,
    status: 'authorized',
  });

  let order = null;
  if (config.paymentsEnabled) {
    try {
      order = await createOrder({
        amountPaise,
        merchantId: req.merchant.merchantId,
        userId: matchedUser._id,
        receipt: `fp_${transaction._id}`,
      });
      transaction.razorpayOrderId = order.id;
      await transaction.save();
    } catch (cause) {
      if (!(cause instanceof RazorpayError)) throw cause;

      // The customer was identified; only the order failed. Recording that
      // distinctly matters — "we could not tell who you are" and "we knew you
      // and the payment gateway was down" are different failures, and rolling
      // both into one would hide gateway trouble inside the biometric numbers.
      transaction.status = 'failed';
      transaction.failureReason = cause.message;
      await transaction.save();

      throw new ApiError(502, `Payment gateway: ${cause.message}`, 'gateway_error');
    }
  }

  res.json({
    charged: true,
    decision: 'matched',
    customer: {
      userId: String(matchedUser._id),
      name: matchedUser.displayName,
    },
    amount: body.amount,
    currency: 'INR',
    status: transaction.status,
    orderId: order?.id ?? null,
    confidence: {
      top: result.top_score,
      runnerUp: result.runner_up_score,
      margin: result.margin,
    },
    gallerySize: result.gallery_size,
    transactionId: String(transaction._id),
    // Said plainly so the kiosk can show it rather than implying the money has
    // moved. See the note on this module.
    settlement: config.paymentsEnabled
      ? 'Order raised at Razorpay. Settlement needs a UPI Autopay mandate, which test mode cannot register.'
      : 'Razorpay is not configured; the authorisation was recorded without an order.',
  });
}
