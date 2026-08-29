import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';
import { Merchant } from '../models/Merchant.js';
import { Transaction } from '../models/Transaction.js';
import { User } from '../models/User.js';
import {
  hashPassword,
  issueToken,
  verifyPassword,
} from '../services/merchantAuth.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  // Long rather than complicated. A shop password guards a terminal that can
  // charge people, and length is the only rule that reliably buys anything.
  password: z.string().min(10).max(200),
});

const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Open a shop account.
 *
 * Anyone may do this, and it grants nothing on its own. The new account can
 * sign in and look at its own empty ledger; what it cannot do is start a
 * verification, because `verified` is false until somebody approves it.
 *
 * That split is the point. Charging already needs the customer's PIN, so the
 * risk in a stranger's terminal is not theft — it is that pointing a camera at
 * a queue and being told everybody's name is a thing you should have to be
 * trusted with. Approval is an administrative act, exactly as issuing the
 * whole account used to be; it is only the account creation that moved.
 */
export async function register(req, res) {
  const body = registerSchema.parse(req.body);

  if (await Merchant.exists({ email: body.email })) {
    // Said plainly. Hiding it would not protect anything -- the sign-in form
    // next door already tells anyone who asks whether an address is taken --
    // and leaving somebody guessing why their signup failed is worse.
    throw new ApiError(409, 'An account already exists for that email', 'email_taken');
  }

  // A random suffix, always. Deriving the id from the name alone would let the
  // first person to sign up as "Corner Store" take the id a real Corner Store
  // would want -- and the id is stamped on every transaction and sits in every
  // customer's knownMerchants, so it is not a label that can be swapped later.
  const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const merchantId = `${slug.slice(0, 28) || 'shop'}-${randomBytes(3).toString('hex')}`;

  const merchant = await Merchant.create({
    merchantId,
    name: body.name,
    email: body.email,
    passwordHash: hashPassword(body.password),
    role: 'merchant',
    verified: false,
  });

  // Signed in immediately. There is nothing to protect by making them log in
  // again, and the account cannot do anything until it is approved anyway.
  res.status(201).json({
    token: issueToken(merchant),
    merchant: {
      merchantId: merchant.merchantId,
      name: merchant.name,
      region: merchant.region,
      role: merchant.role,
      verified: merchant.verified,
    },
  });
}

export async function login(req, res) {
  const body = loginSchema.parse(req.body);

  const merchant = await Merchant.findOne({ email: body.email }).select(
    '+passwordHash',
  );

  // One message for "no such account" and "wrong password", and the password
  // is verified even when the account does not exist. Otherwise both the
  // wording and the response time tell an attacker which emails are real.
  const ok =
    merchant?.active &&
    verifyPassword(body.password, merchant.passwordHash ?? 'x:00');

  if (!ok) {
    throw new ApiError(401, 'Email or password is incorrect', 'invalid_credentials');
  }

  res.json({
    token: issueToken(merchant),
    merchant: {
      merchantId: merchant.merchantId,
      name: merchant.name,
      region: merchant.region,
      // So the client knows which screen to open. Not an authorisation check
      // -- the role that matters is the one signed into the token and read
      // again from the database; this only saves showing an admin a till they
      // cannot use, or a merchant a dashboard the API would refuse anyway.
      role: merchant.role,
      // So the till can explain itself before the customer is standing there,
      // rather than failing at the moment somebody looks into the camera.
      verified: merchant.verified,
    },
  });
}

/** Who the caller is signed in as. Lets a terminal restore its own session. */
export async function whoami(req, res) {
  const merchant = await Merchant.findOne({ merchantId: req.merchant.merchantId });
  if (!merchant?.active) {
    throw new ApiError(401, 'Session is no longer valid', 'invalid_session');
  }

  res.json({
    merchantId: merchant.merchantId,
    name: merchant.name,
    region: merchant.region,
    verified: merchant.verified,
  });
}

export async function history(req, res) {
  const { limit } = historySchema.parse(req.query);

  // Scoped to the signed-in merchant, from the token — never from a parameter.
  // A merchantId taken from the request would let any terminal read another
  // shop's takings by changing one value.
  const transactions = await Transaction.find({
    merchantId: req.merchant.merchantId,
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('user', 'displayName')
    .lean();

  const totalPaise = transactions
    .filter((t) => t.status !== 'failed')
    .reduce((sum, t) => sum + t.amountPaise, 0);

  res.json({
    transactions: transactions.map((t) => ({
      id: String(t._id),
      amount: t.amountPaise / 100,
      currency: t.currency,
      status: t.status,
      customer: t.user?.displayName ?? 'Unknown',
      matchScore: t.matchScore,
      authFactors: t.authFactors,
      orderId: t.razorpayOrderId,
      at: t.createdAt,
    })),
    summary: {
      count: transactions.length,
      total: totalPaise / 100,
    },
  });
}

/** Enrolled customers, for the terminal to show how large the gallery is. */
export async function stats(_req, res) {
  const [customers, transactions] = await Promise.all([
    User.countDocuments({ status: 'active' }),
    Transaction.countDocuments(),
  ]);

  res.json({ enrolledCustomers: customers, totalTransactions: transactions });
}
