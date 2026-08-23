import { z } from 'zod';

import { config } from '../config/index.js';
import { ApiError } from '../middleware/errorHandler.js';
import { Transaction } from '../models/Transaction.js';
import {
  identifyFromSession,
  loadVerificationSession,
} from '../services/identification.js';
import { createOrder, RazorpayError } from '../services/razorpay.js';
import { verifyPin } from '../services/pin.js';
import { User } from '../models/User.js';

const chargeSchema = z.object({
  sessionId: z.string().min(1),
  // Rupees at the till, converted to paise below. Capped so a typo cannot
  // create an order for a fortune during a demo.
  amount: z.number().positive().max(100000),
  // The knowledge factor. Absent on the first call: the till does not know
  // whose PIN to ask for until the face has been identified, so the flow is
  // scan, then prompt, then charge.
  pin: z.string().regex(/^\d{4}$/).nullish(),
});

// Failed PIN attempts before an identity is locked. Four digits is only ten
// thousand possibilities, so this — not the hash — is what actually protects
// it, exactly as at a cash machine.
const MAX_PIN_FAILURES = 3;
const LOCKOUT_MINUTES = 15;

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

  // A payment takes two calls: identify, then verify the PIN. The till cannot
  // prompt for a PIN until the face has said whose to ask for. On the second
  // call the identification is already on the session — re-running it is not
  // possible anyway, since the ML service discards its own session the moment
  // it answers a match.
  let matchedUser;
  let logId;
  let confidence;

  if (session.identifiedUser) {
    matchedUser = await User.findById(session.identifiedUser);
    logId = session.identifiedLog;
    confidence = {
      top: session.matchScore,
      runnerUp: session.runnerUpScore,
      margin:
        session.matchScore != null && session.runnerUpScore != null
          ? Number((session.matchScore - session.runnerUpScore).toFixed(4))
          : null,
    };
  } else {
    const identified = await identifyFromSession(session, { completeOnMatch: false });
    matchedUser = identified.matchedUser;
    logId = identified.log._id;
    confidence = {
      top: identified.result.top_score,
      runnerUp: identified.result.runner_up_score,
      margin: identified.result.margin,
    };

    if (!matchedUser) {
      // Nothing to charge, and nothing worth keeping the session open for.
      // The attempt is already in the audit trail.
      session.completed = true;
      await session.save();

      return res.json({
        charged: false,
        decision: identified.result.decision,
        reason:
          identified.result.decision === 'ambiguous'
            ? 'Two enrolled faces scored too close to tell apart'
            : 'No enrolled customer matched',
        confidence,
        gallerySize: identified.result.gallery_size,
        logId: String(identified.log._id),
      });
    }

    // A benchmark face is not a customer. Those rows are research images
    // loaded to make the gallery a realistic size, and reaching this line
    // means a live person out-scored every real customer against one of them —
    // a false match, which is exactly what the benchmark exists to detect.
    //
    // Refused here rather than left to fail later at the PIN step. It would
    // fail there anyway, benchmark rows having no PIN, but it would be
    // recorded as "this customer never set a PIN" and the one event most worth
    // seeing would be filed under a routine one.
    if (matchedUser.source === 'benchmark') {
      console.warn(
        `[charge] FALSE MATCH against benchmark row ${matchedUser._id} ` +
          `(${matchedUser.benchmarkLabel}) at ${confidence.top} ` +
          `over ${identified.result.gallery_size} candidates — log ${logId}`,
      );

      session.completed = true;
      await session.save();

      return res.json({
        charged: false,
        decision: 'benchmark_match',
        reason:
          'The closest face in the gallery is a benchmark record, not an ' +
          'enrolled customer. Nothing was charged.',
        confidence,
        gallerySize: identified.result.gallery_size,
        logId: String(logId),
      });
    }

    // Remembered so the PIN can arrive in a second call.
    session.identifiedUser = matchedUser._id;
    session.identifiedLog = identified.log._id;
    session.matchScore = identified.result.top_score;
    session.runnerUpScore = identified.result.runner_up_score;
    session.gallerySize = identified.result.gallery_size;
    await session.save();
  }

  // Second factor. The face said who; the PIN is how they approve — which is
  // the answer to the obvious question about a customer with no device at the
  // till. Without it this is single-factor, and RBI requires two.
  const pinCheck = await checkPin(matchedUser, body.pin);
  if (!pinCheck.ok) {
    // A lockout or a missing PIN ends the session; a wrong PIN with tries left
    // does not, so the customer can try again without rescanning their face.
    if (pinCheck.outcome === 'locked' || pinCheck.outcome === 'no_pin_set') {
      session.completed = true;
      await session.save();
    }

    // Answered 200 deliberately. A refused PIN is a business outcome, not a
    // failed request, and an error-shaped body would lose the reason the till
    // needs to show. `no_match` above answers the same way.
    return res.json({
      charged: false,
      decision: 'matched',
      pinOutcome: pinCheck.outcome,
      needsPin: pinCheck.outcome === 'needs_pin' || pinCheck.outcome === 'wrong_pin',
      customer: { userId: String(matchedUser._id), name: matchedUser.displayName },
      reason: pinCheck.reason,
      attemptsLeft: pinCheck.attemptsLeft,
      confidence,
      gallerySize: session.gallerySize,
      logId: String(logId),
    });
  }

  session.completed = true;
  await session.save();

  const amountPaise = Math.round(body.amount * 100);

  const transaction = await Transaction.create({
    merchantId: req.merchant.merchantId,
    user: matchedUser._id,
    amountPaise,
    // What actually happened, recorded rather than assumed. As factors are
    // added this is what keeps the audit trail honest about which ones a given
    // payment really rested on.
    authFactors: ['face', 'pin'],
    verificationLog: logId,
    matchScore: confidence.top,
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
    // What the customer actually proved, so a receipt can state it rather than
    // assume it. Read off the stored transaction for the same reason it is
    // stored there: as factors are added, a slip that guessed would start
    // lying.
    authFactors: transaction.authFactors,
    orderId: order?.id ?? null,
    confidence,
    gallerySize: session.gallerySize,
    transactionId: String(transaction._id),
    // Said plainly so the kiosk can show it rather than implying the money has
    // moved. See the note on this module.
    settlement: config.paymentsEnabled
      ? 'Order raised at Razorpay. Settlement needs a UPI Autopay mandate, which test mode cannot register.'
      : 'Razorpay is not configured; the authorisation was recorded without an order.',
  });
}

/**
 * Check the second factor for an identified customer.
 *
 * Returns a verdict rather than throwing, because "we know who you are, now
 * enter your PIN" is a normal step in the flow and not an error — the till has
 * to be able to prompt, and it cannot prompt until the face has said whose PIN
 * to ask for.
 *
 * The lockout is the real protection. A four-digit PIN is ten thousand
 * possibilities, which no hash makes expensive enough to matter; what stops
 * guessing is running out of tries, exactly as at a cash machine.
 */
async function checkPin(user, pin) {
  // The hash is `select: false`, so it has to be asked for explicitly.
  const record = await User.findById(user._id).select('+pinHash');

  if (!record.pinHash) {
    return {
      ok: false,
      outcome: 'no_pin_set',
      reason:
        'This customer has not set a PIN yet. They can add one by registering ' +
        'again on their own device.',
    };
  }

  if (record.pinLockedUntil && record.pinLockedUntil > new Date()) {
    const minutes = Math.ceil((record.pinLockedUntil - Date.now()) / 60000);
    return {
      ok: false,
      outcome: 'locked',
      reason: `Too many wrong PINs. Locked for another ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }

  if (!pin) {
    return { ok: false, outcome: 'needs_pin', reason: 'PIN required' };
  }

  if (verifyPin(pin, record.pinHash)) {
    // Only a success clears the counter. Leaving it to expire instead would
    // let an attacker reset their budget by waiting out the lockout window.
    if (record.pinFailures > 0) {
      await User.updateOne(
        { _id: record._id },
        { $set: { pinFailures: 0, pinLockedUntil: null } },
      );
    }
    return { ok: true };
  }

  const failures = record.pinFailures + 1;
  const locked = failures >= MAX_PIN_FAILURES;

  await User.updateOne(
    { _id: record._id },
    {
      $set: {
        pinFailures: locked ? 0 : failures,
        pinLockedUntil: locked ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null,
      },
    },
  );

  return {
    ok: false,
    outcome: locked ? 'locked' : 'wrong_pin',
    attemptsLeft: locked ? 0 : MAX_PIN_FAILURES - failures,
    reason: locked
      ? `Too many wrong PINs. Locked for ${LOCKOUT_MINUTES} minutes.`
      : `Wrong PIN. ${MAX_PIN_FAILURES - failures} attempt${MAX_PIN_FAILURES - failures === 1 ? '' : 's'} left.`,
  };
}
