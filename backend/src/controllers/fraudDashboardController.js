import { z } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';
import { FraudFlag } from '../models/FraudFlag.js';
import { Merchant } from '../models/Merchant.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { RULES } from '../rules/index.js';

const listSchema = z.object({
  status: z.enum(['open', 'cleared', 'confirmed', 'all']).default('open'),
  severity: z.enum(['review', 'suspicious', 'high_risk']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const reviewSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

/** Everything the dashboard needs about a flag, without the evidence bodies. */
function summarise(flag) {
  const rule = RULES.find((r) => r.name === flag.rule);

  return {
    id: String(flag._id),
    rule: flag.rule,
    // Generated from the rule rather than stored on the flag, so changing the
    // wording does not require rewriting history.
    description: rule ? rule.describe(flag.count) : `${flag.count} events`,
    severity: flag.severity,
    deviceId: flag.deviceId,
    merchantId: flag.merchantId,
    user: flag.matchedUser
      ? {
          userId: String(flag.matchedUser._id ?? flag.matchedUser),
          displayName: flag.matchedUser.displayName ?? null,
        }
      : null,
    count: flag.count,
    windowStart: flag.windowStart,
    windowEnd: flag.windowEnd,
    evidenceCount: flag.evidence?.length ?? 0,
    status: flag.status,
    reviewedBy: flag.reviewedBy,
    reviewedAt: flag.reviewedAt,
    note: flag.note,
    raisedAt: flag.createdAt,
  };
}

export async function list(req, res) {
  const query = listSchema.parse(req.query);

  const filter = {};
  if (query.status !== 'all') filter.status = query.status;
  if (query.severity) filter.severity = query.severity;

  const flags = await FraudFlag.find(filter)
    .populate({ path: 'matchedUser', select: 'displayName' })
    .sort({ createdAt: -1 })
    .limit(query.limit)
    .lean();

  // Counts for the whole collection rather than the page, so the header does
  // not change meaning when a filter is applied.
  const [open, high] = await Promise.all([
    FraudFlag.countDocuments({ status: 'open' }),
    FraudFlag.countDocuments({ status: 'open', severity: 'high_risk' }),
  ]);

  res.json({
    flags: flags.map(summarise),
    totals: { open, highRisk: high },
    // Sent so the dashboard can say what is being watched for, including the
    // thresholds. A reviewer looking at a flag should be able to see the rule
    // that produced it without reading the source.
    rules: RULES.map((rule) => ({
      name: rule.name,
      severity: rule.severity,
      threshold: rule.threshold,
      windowMinutes: rule.windowMs / 60000,
      attributesIdentity: rule.attributesIdentity,
    })),
  });
}

export async function detail(req, res) {
  const flag = await FraudFlag.findById(req.params.id)
    .populate({ path: 'matchedUser', select: 'displayName' })
    .lean();

  if (!flag) throw new ApiError(404, 'No such flag', 'not_found');

  // The attempts the rule counted. A number a reviewer cannot check is a
  // number they have to take on faith, which is the opposite of what an audit
  // trail is for.
  const evidence = await VerificationLog.find({ _id: { $in: flag.evidence } })
    .select(
      'createdAt outcome pinOutcome matchedUser deviceId merchantId scores liveness.failureReason liveness.spoofRealScore',
    )
    .populate({ path: 'matchedUser', select: 'displayName' })
    .sort({ createdAt: 1 })
    .lean();

  res.json({
    flag: summarise(flag),
    evidence: evidence.map((row) => ({
      id: String(row._id),
      at: row.createdAt,
      outcome: row.outcome,
      pinOutcome: row.pinOutcome ?? null,
      failureReason: row.liveness?.failureReason ?? null,
      spoofRealScore: row.liveness?.spoofRealScore ?? null,
      topScore: row.scores?.top ?? null,
      user: row.matchedUser?.displayName ?? null,
    })),
  });
}

/** Mark a flag reviewed — either dismissed or confirmed as real. */
async function review(req, res, status) {
  const body = reviewSchema.parse(req.body ?? {});

  const flag = await FraudFlag.findById(req.params.id);
  if (!flag) throw new ApiError(404, 'No such flag', 'not_found');

  // Reviewing is one-way. Re-opening a decided flag would let the record of
  // what somebody decided, and when, be quietly rewritten.
  if (flag.status !== 'open') {
    throw new ApiError(409, 'This flag has already been reviewed', 'already_reviewed');
  }

  flag.status = status;
  flag.reviewedBy = req.admin.merchantId;
  flag.reviewedAt = new Date();
  if (body.note) flag.note = body.note;
  await flag.save();

  res.json({ flag: summarise(flag) });
}

/**
 * Shops that have signed up and cannot scan yet.
 *
 * Approving one used to mean a command line, which put it out of reach of
 * whoever happens to be holding a phone when a shop signs up. The decision
 * itself is unchanged -- an admin still makes it -- it just has a button now.
 */
export async function pendingMerchants(_req, res) {
  const merchants = await Merchant.find({ verified: false, active: true })
    .select('merchantId name email createdAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.json({
    merchants: merchants.map((m) => ({
      id: String(m._id),
      merchantId: m.merchantId,
      name: m.name,
      email: m.email,
      signedUpAt: m.createdAt,
    })),
  });
}

/** Let a shop's terminal start looking at customers. */
export async function verifyMerchant(req, res) {
  const shop = await Merchant.findById(req.params.id);
  if (!shop) throw new ApiError(404, 'No such merchant', 'not_found');

  if (shop.verified) {
    // Not an error worth failing on -- two admins pressing the same button is
    // the same outcome either way.
    return res.json({ merchantId: shop.merchantId, verified: true });
  }

  shop.verified = true;
  await shop.save();

  return res.json({ merchantId: shop.merchantId, verified: true });
}

export const clear = (req, res) => review(req, res, 'cleared');
export const confirm = (req, res) => review(req, res, 'confirmed');
