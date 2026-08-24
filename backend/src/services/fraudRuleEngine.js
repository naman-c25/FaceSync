import { FraudFlag } from '../models/FraudFlag.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { RULES } from '../rules/index.js';

// A long incident should not grow a document without limit. The most recent
// entries are the ones a reviewer opens; `count` keeps the true total.
const MAX_EVIDENCE = 50;

/**
 * Check one freshly written verification log against every rule.
 *
 * Called from the log-write path rather than a scheduler. A cron job would be
 * a second thing to deploy, keep alive and reason about, for a system whose
 * whole trigger is "a row was just written" — so the check happens where the
 * row is written.
 *
 * It is awaited, which costs latency on the request that wrote the log. Two
 * things keep that small: `matches()` runs first and is pure, so the ordinary
 * case — a successful verification — does no database work at all; and the
 * window query is served by the `(deviceId, createdAt)` index. Only failures
 * pay for anything.
 *
 * Nothing it throws is allowed out. A bug in a fraud heuristic must never be
 * able to refuse a payment that the biometrics and the PIN both approved —
 * that would turn a monitoring feature into an outage.
 *
 * @returns {Promise<Array>} flags raised or extended, for tests and callers
 *   that want to react. Empty on error, by design.
 */
export async function evaluate(log) {
  // Rules are scoped to a terminal. A log without one cannot be windowed
  // against anything, and guessing which device it came from would put
  // unrelated attempts in the same bucket.
  if (!log?.deviceId || !log?.createdAt) return [];

  const raised = [];

  for (const rule of RULES) {
    try {
      if (!rule.matches(log)) continue;

      const windowStart = new Date(log.createdAt.getTime() - rule.windowMs);
      const rows = await VerificationLog.find({
        deviceId: log.deviceId,
        createdAt: { $gte: windowStart, $lte: log.createdAt },
        ...rule.filter,
      })
        .select('_id createdAt matchedUser')
        .sort({ createdAt: 1 })
        .lean();

      if (rows.length < rule.threshold) continue;

      raised.push(await record(rule, log, rows));
    } catch (cause) {
      // Deliberately swallowed after being reported. See the note above.
      console.error(
        `[fraud] rule ${rule.name} failed on log ${log._id}: ${cause.message}`,
      );
    }
  }

  return raised;
}

/**
 * Raise a new flag, or extend the incident that is already open.
 *
 * The distinction matters more than it looks. A rolling window keeps firing
 * for as long as a terminal stays over the threshold — measured against the
 * real log, one run of failures fired thirty-four times. Thirty-four rows for
 * one event is a dashboard nobody can read, and the next genuine flag arrives
 * buried under them.
 */
async function record(rule, log, rows) {
  const evidence = rows.slice(-MAX_EVIDENCE).map((row) => row._id);
  const windowStart = rows[0].createdAt;

  // Same rule, same terminal, still open, and its window has not closed since
  // the last time it fired — that is the same incident continuing.
  const open = await FraudFlag.findOne({
    rule: rule.name,
    deviceId: log.deviceId,
    status: 'open',
    windowEnd: { $gte: new Date(log.createdAt.getTime() - rule.windowMs) },
  }).sort({ windowEnd: -1 });

  if (open) {
    open.count = rows.length;
    open.windowStart = windowStart;
    open.windowEnd = log.createdAt;
    open.evidence = evidence;
    // A later attempt can attribute an incident the first one could not.
    if (rule.attributesIdentity && log.matchedUser) {
      open.matchedUser = log.matchedUser;
    }
    await open.save();
    return open;
  }

  return FraudFlag.create({
    rule: rule.name,
    severity: rule.severity,
    deviceId: log.deviceId,
    merchantId: log.merchantId ?? null,
    matchedUser: rule.attributesIdentity ? (log.matchedUser ?? null) : null,
    count: rows.length,
    windowStart,
    windowEnd: log.createdAt,
    evidence,
  });
}
