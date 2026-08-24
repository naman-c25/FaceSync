import { z } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';
import { Merchant } from '../models/Merchant.js';
import { Transaction } from '../models/Transaction.js';
import { User } from '../models/User.js';
import { issueToken, verifyPassword } from '../services/merchantAuth.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

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
