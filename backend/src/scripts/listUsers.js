import mongoose from 'mongoose';

import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { VerificationLog } from '../models/VerificationLog.js';

/**
 * Who has registered, and how well the system actually recognises them.
 *
 *     npm run users              # the people who walked up to a camera
 *     npm run users -- --all     # plus the benchmark gallery
 *
 * The `users` collection holds two very different things: real registrations
 * and the 2000 LFW rows loaded to make 1:N realistic. Opening the collection
 * in Compass shows page 1 of 2013 in insertion order, where a new registration
 * is invisible. So this filters to `source: "live"` by default.
 *
 * The scan columns matter more than the enrollment column, and it is worth
 * saying why, because the obvious reading is the wrong one. A high
 * `enrollment.meanSimilarity` only says the five capture samples agreed with
 * each other — all taken seconds apart, in one light, at one distance. It does
 * not predict how the person scores on a different day, and measured here it
 * does not: one user enrolled at 0.92 averages 0.76 in use, while another
 * enrolled at 0.87 averages 0.84.
 *
 * `min` is the column to read. Someone scanned once always looks perfect;
 * their worst score is also their only one. It takes repeat use before the low
 * readings appear, and those are the ones that decide whether this works in
 * front of an audience.
 */
const includeBenchmark = process.argv.includes('--all');

function pct(part, whole) {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

async function main() {
  await mongoose.connect(config.MONGODB_URI);

  const filter = includeBenchmark ? {} : { source: 'live' };
  const users = await User.find(filter)
    .select('displayName status source enrollment createdAt pinHash')
    .sort({ createdAt: -1 })
    .lean();

  if (users.length === 0) {
    console.log('No users yet.');
    return;
  }

  // One round trip rather than one per user. Only matched attempts can be
  // attributed to anyone — a failure has no identity by definition, which is
  // why the outcome summary below is reported separately rather than as a
  // per-user column.
  const activity = await VerificationLog.aggregate([
    { $match: { matchedUser: { $ne: null } } },
    {
      $group: {
        _id: '$matchedUser',
        scans: { $sum: 1 },
        avgTop: { $avg: '$scores.top' },
        minTop: { $min: '$scores.top' },
        lastSeen: { $max: '$createdAt' },
      },
    },
  ]);
  const byUser = new Map(activity.map((a) => [String(a._id), a]));

  const width = Math.max(...users.map((u) => u.displayName.length), 4);
  const when = (d) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—');
  const num = (v, places = 3) =>
    Number.isFinite(v) ? v.toFixed(places) : '  —  ';

  console.log(
    `\n${users.length} ${includeBenchmark ? 'users' : 'live users'}, newest first\n`,
  );
  console.log(
    `${'registered'.padEnd(17)}${'name'.padEnd(width)}  pin  scans    avg    min  enrol`,
  );
  console.log('─'.repeat(17 + width + 32));

  let untested = 0;

  for (const user of users) {
    const seen = byUser.get(String(user._id));
    if (!seen || seen.scans < 2) untested += 1;

    console.log(
      when(user.createdAt).padEnd(17) +
        user.displayName.padEnd(width) +
        `  ${user.pinHash ? ' y ' : ' – '}` +
        String(seen?.scans ?? 0).padStart(6) +
        `  ${num(seen?.avgTop)}  ${num(seen?.minTop)}` +
        `  ${num(user.enrollment?.meanSimilarity)}`,
    );
  }

  if (untested > 0) {
    console.log(
      `\n${untested} of ${users.length} have been scanned once or never — ` +
        'their scores here are not yet evidence of anything.',
    );
  }

  // Where the attempts actually go. Identification is only the last step, and
  // a session that fails before it never reaches a user to be counted against
  // — so this is the only place those failures show up at all.
  const outcomes = await VerificationLog.aggregate([
    { $group: { _id: '$outcome', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const total = outcomes.reduce((sum, o) => sum + o.n, 0);

  console.log(`\n${total} verification attempts`);
  for (const outcome of outcomes) {
    console.log(
      `  ${String(outcome._id).padEnd(17)}${String(outcome.n).padStart(5)}  ` +
        `${pct(outcome.n, total).padStart(6)}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
