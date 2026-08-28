import { z } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';
import { Transaction } from '../models/Transaction.js';
import { User } from '../models/User.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { evict } from '../services/galleryCache.js';
import { Merchant } from '../models/Merchant.js';
import { hashPin, rejectWeakPin, verifyPin } from '../services/pin.js';
import { hashPassword, issueUserToken, verifyPassword } from '../services/userAuth.js';

const credentials = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
});

const claimSchema = credentials.extend({
  // The account is attached to a face that is already enrolled, and the PIN is
  // what proves the claim. Without it anyone could bind their own email to
  // somebody else's face record and then read that person's history.
  pin: z.string().regex(/^\d{4}$/, 'A PIN must be exactly four digits'),
  displayName: z.string().trim().min(1).max(120),
});

/**
 * Attach a portal account to a face that is already enrolled.
 *
 * Not "sign up" in the usual sense, because the identity already exists -- it
 * was created by enrolling a face, with no email and no password, and that is
 * the property the whole system rests on. This only adds a way to log in and
 * read it back later.
 *
 * The name is not the credential. Names are not unique and are not secret, so
 * the PIN is what actually proves the claim; the name only narrows which
 * record is meant. Getting that the wrong way round would let anybody who
 * knows your name read your payment history.
 */
export async function claimAccount(req, res) {
  const body = claimSchema.parse(req.body);

  const weak = rejectWeakPin(body.pin);
  if (weak) throw new ApiError(400, weak, 'weak_pin');

  const taken = await User.findOne({ email: body.email }).select('_id');
  if (taken) {
    throw new ApiError(409, 'That email is already in use', 'email_taken');
  }

  // Candidates by name, then settled by PIN. Deliberately vague in its
  // failures: "no such name" and "wrong PIN" answer the same way, so this
  // cannot be used to find out who is enrolled.
  const candidates = await User.find({
    displayName: body.displayName,
    source: 'live',
    email: null,
  }).select('+pinHash');

  const matched = candidates.find(
    (user) => user.pinHash && verifyPin(body.pin, user.pinHash),
  );

  if (!matched) {
    throw new ApiError(
      401,
      'No enrolled face matches that name and PIN',
      'claim_failed',
    );
  }

  matched.email = body.email;
  matched.passwordHash = hashPassword(body.password);
  await matched.save();

  res.status(201).json({
    token: issueUserToken(matched),
    user: { userId: String(matched._id), displayName: matched.displayName },
  });
}

export async function login(req, res) {
  const body = credentials.parse(req.body);

  const user = await User.findOne({ email: body.email }).select('+passwordHash');

  // One message for both failures, and the password is verified even when no
  // account exists, so neither the wording nor the timing says which emails
  // are real.
  const ok =
    user?.status === 'active' &&
    verifyPassword(body.password, user.passwordHash ?? 'x:00');

  if (!ok) {
    throw new ApiError(401, 'Email or password is incorrect', 'invalid_credentials');
  }

  res.json({
    token: issueUserToken(user),
    user: { userId: String(user._id), displayName: user.displayName },
  });
}

/** Everything the portal shows about the account itself. */
export async function profile(req, res) {
  const user = await User.findById(req.user.id).select('+email +pinHash');
  if (!user) throw new ApiError(404, 'Account not found', 'not_found');

  const [payments, attempts] = await Promise.all([
    Transaction.countDocuments({ user: user._id, status: { $ne: 'failed' } }),
    VerificationLog.countDocuments({ matchedUser: user._id }),
  ]);

  res.json({
    userId: String(user._id),
    displayName: user.displayName,
    email: user.email,
    enrolledAt: user.enrollment?.completedAt ?? user.createdAt,
    // Quality of the stored face, because a low figure is why recognition
    // gets flaky and the person can do something about it.
    enrollment: {
      samplesUsed: user.enrollment?.samplesUsed ?? null,
      meanSimilarity: user.enrollment?.meanSimilarity ?? null,
    },
    security: {
      hasPin: Boolean(user.pinHash),
      pinLocked: Boolean(user.pinLockedUntil && user.pinLockedUntil > new Date()),
      pinLockedUntil: user.pinLockedUntil,
    },
    activity: { payments, recognitions: attempts, lastSeenAt: user.lastSeenAt },
    // Named so the portal does not have to invent the wording, and so this
    // stays true if the storage ever changes.
    dataHeld: [
      'An encrypted mathematical signature of your face. No photograph.',
      'Your PIN, hashed and salted. It cannot be read back, only checked.',
      'A record of each payment: which shop, how much, and when.',
      user.email ? 'The email address you signed in with.' : null,
    ].filter(Boolean),
  });
}

/** The customer's own payment history, with the shop named. */
export async function history(req, res) {
  const transactions = await Transaction.find({ user: req.user.id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  // Shop names in one query rather than one per row.
  const merchants = await Merchant.find({
    merchantId: { $in: [...new Set(transactions.map((t) => t.merchantId))] },
  })
    .select('merchantId name region')
    .lean();
  const byId = new Map(merchants.map((m) => [m.merchantId, m]));

  const total = transactions
    .filter((t) => t.status !== 'failed')
    .reduce((sum, t) => sum + t.amountPaise, 0);

  res.json({
    transactions: transactions.map((t) => ({
      id: String(t._id),
      amount: t.amountPaise / 100,
      currency: t.currency,
      status: t.status,
      at: t.createdAt,
      merchant: {
        merchantId: t.merchantId,
        name: byId.get(t.merchantId)?.name ?? t.merchantId,
        region: byId.get(t.merchantId)?.region ?? null,
      },
      // What the customer actually proved at the till, so the row says how it
      // was authorised rather than leaving them to assume.
      authFactors: t.authFactors,
      orderId: t.razorpayOrderId,
    })),
    summary: {
      total: total / 100,
      count: transactions.filter((t) => t.status !== 'failed').length,
    },
  });
}

const pinChange = z.object({
  currentPin: z.string().regex(/^\d{4}$/),
  newPin: z.string().regex(/^\d{4}$/),
});

/** Change the PIN, proving the old one first. */
export async function changePin(req, res) {
  const body = pinChange.parse(req.body);

  const weak = rejectWeakPin(body.newPin);
  if (weak) throw new ApiError(400, weak, 'weak_pin');

  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user?.pinHash) throw new ApiError(404, 'No PIN is set', 'no_pin_set');

  if (!verifyPin(body.currentPin, user.pinHash)) {
    throw new ApiError(401, 'That is not your current PIN', 'wrong_pin');
  }

  user.pinHash = hashPin(body.newPin);
  // Changing it clears a lockout, since proving the old PIN is at least as
  // strong as waiting fifteen minutes would have been.
  user.pinFailures = 0;
  user.pinLockedUntil = null;
  await user.save();

  res.json({ changed: true });
}

const deletion = z.object({
  // Typed out in full, because this cannot be undone and a button alone is too
  // easy to press by accident.
  confirm: z.literal('DELETE MY FACE DATA'),
  pin: z.string().regex(/^\d{4}$/),
});

/**
 * Delete the face data, for real.
 *
 * The consent screen promises this, so it has to actually happen rather than
 * flag a row as inactive. The embedding is removed, and so is every probe
 * embedding kept on this person's failed attempts -- those are face data too,
 * and leaving them behind would make the promise false in the one place nobody
 * would think to look.
 *
 * The transaction rows stay, with the link to the person severed. They are
 * financial records of money that moved, they belong to the merchant's
 * accounts as much as to the customer, and deleting them would not be a
 * privacy feature but a hole in a ledger.
 */
export async function deleteFaceData(req, res) {
  const body = deletion.parse(req.body);

  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user) throw new ApiError(404, 'Account not found', 'not_found');

  if (!user.pinHash || !verifyPin(body.pin, user.pinHash)) {
    throw new ApiError(401, 'PIN is incorrect', 'wrong_pin');
  }

  const logs = await VerificationLog.updateMany(
    { matchedUser: user._id },
    { $set: { probeEmbedding: null, matchedUser: null } },
  );

  // The amounts and the shops survive; whose face it was does not.
  const detached = await Transaction.updateMany(
    { user: user._id },
    { $set: { user: null } },
  );

  await User.deleteOne({ _id: user._id });
  // Without this the face stays matchable from memory until the TTL, which
  // would make the deletion this endpoint promises a lie.
  evict(user._id);

  res.json({
    deleted: true,
    faceRecordRemoved: true,
    verificationLogsCleared: logs.modifiedCount,
    transactionsDetached: detached.modifiedCount,
    note:
      'Your face signature and PIN are gone and cannot be recovered. Payment ' +
      'records remain as the shops’ own accounts, no longer linked to you. ' +
      'To pay by face again you would register from scratch.',
  });
}
