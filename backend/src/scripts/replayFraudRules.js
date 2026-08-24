import mongoose from 'mongoose';

import { config } from '../config/index.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { RULES } from '../rules/index.js';

/**
 * Replay every historical verification through the rules, without writing anything.
 *
 *     node src/scripts/replayFraudRules.js
 *     node src/scripts/replayFraudRules.js --sweep
 *
 * A fraud threshold that nobody has run against real traffic is a guess with a
 * decimal point in it. This is how the shipped numbers were arrived at: the
 * first proposal for the liveness rule was three failures in five minutes, and
 * replayed over logs that were entirely our own legitimate testing it fired
 * again and again. Five is what came out of running this, not out of a meeting.
 *
 * Two counts are reported and the difference between them matters:
 *
 *   firings    every attempt that was over the threshold when it arrived
 *   incidents  what the dashboard would actually show, after a burst is
 *              collapsed into one flag that grows
 *
 * The rules are imported rather than restated, so this cannot drift from what
 * runs in production. `--sweep` tries neighbouring thresholds, which is the
 * thing to look at before changing one.
 */
const sweep = process.argv.includes('--sweep');

/**
 * Count firings and incidents for one rule at one threshold.
 *
 * Mirrors the engine: a rolling window per terminal, and a firing that lands
 * inside an open incident's window extends it instead of raising another.
 */
function replay(rule, logs, threshold) {
  const windows = new Map();
  const lastFiring = new Map();
  let firings = 0;
  let incidents = 0;

  for (const log of logs) {
    if (!log.deviceId || !rule.matches(log)) continue;

    const at = log.createdAt.getTime();
    const key = log.deviceId;

    const times = windows.get(key) ?? [];
    times.push(at);
    while (times.length && at - times[0] > rule.windowMs) times.shift();
    windows.set(key, times);

    if (times.length < threshold) continue;

    firings += 1;
    const previous = lastFiring.get(key);
    if (previous === undefined || at - previous > rule.windowMs) incidents += 1;
    lastFiring.set(key, at);
  }

  return { firings, incidents };
}

async function main() {
  await mongoose.connect(config.MONGODB_URI);

  const logs = await VerificationLog.find({})
    .select('createdAt outcome deviceId matchedUser liveness.failureReason')
    .sort({ createdAt: 1 })
    .lean();

  if (logs.length === 0) {
    console.log('No verification logs to replay.');
    return;
  }

  const span = (logs.at(-1).createdAt - logs[0].createdAt) / 86400000;
  const terminals = new Set(logs.map((log) => log.deviceId).filter(Boolean));

  console.log(
    `\n${logs.length} verification logs over ${span.toFixed(1)} days, ` +
      `${terminals.size} terminal${terminals.size === 1 ? '' : 's'}\n`,
  );

  console.log('rule                threshold  matching rows  firings  incidents');
  console.log('─'.repeat(68));

  for (const rule of RULES) {
    const matching = logs.filter((log) => rule.matches(log)).length;
    const thresholds = sweep
      ? [...new Set([rule.threshold - 2, rule.threshold - 1, rule.threshold, rule.threshold + 1, rule.threshold + 2])].filter((n) => n >= 2)
      : [rule.threshold];

    for (const threshold of thresholds) {
      const { firings, incidents } = replay(rule, logs, threshold);
      const shipped = threshold === rule.threshold;
      console.log(
        `${rule.name.padEnd(20)}${String(threshold).padStart(6)}${shipped ? ' *' : '  '}` +
          `${String(matching).padStart(14)}${String(firings).padStart(9)}${String(incidents).padStart(11)}`,
      );
    }
    if (sweep) console.log('');
  }

  if (!sweep) {
    console.log('\n  * the shipped threshold. Add --sweep to see the neighbours.');
  }

  // Which of these numbers is a mistake depends on the rule, and saying
  // "all of them" would be the easy claim rather than the true one.
  console.log(
    [
      '',
      'Reading these: the log is our own testing, which was mostly ordinary',
      'use and partly deliberate spoofing with photos and phone screens.',
      '',
      '  spoof_burst        those attacks were real -- its incidents are hits',
      '  liveness_velocity  nobody was attacking -- its incidents are misfires',
      '  pin_velocity       no history at all. Refused PINs went unlogged until',
      '                     this rule needed them, so it starts empty',
      '',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
