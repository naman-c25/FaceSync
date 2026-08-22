import mongoose from 'mongoose';

import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { buildCandidatePool } from '../services/candidatePool.js';
import { decryptEmbedding } from '../services/encryption.js';

/**
 * Measure what the benchmark gallery does to the real customers in it.
 *
 *     node src/scripts/measureAccuracy.js
 *     node src/scripts/measureAccuracy.js --json ../benchmark-data/live-vs-benchmark.json
 *
 * `ml-service/tools/benchmark_1n.py` measures the recognition model on dataset
 * faces. This measures the system: the actual encrypted rows in the actual
 * database, read through the actual candidate pool, using the same decryption
 * the payment path uses. The two ask different questions, and the second one is
 * the one a merchant would care about —
 *
 *   "with two thousand strangers in the gallery, how close does the nearest one
 *    come to being mistaken for me?"
 *
 * Two things are reported:
 *
 *   Headroom. For each enrolled person, how far the best impostor score sits
 *   below the match threshold. This is the margin of safety they are actually
 *   running on, and it is the number that shrinks as the gallery grows. A
 *   person whose nearest stranger is at 0.44 against a threshold of 0.45 is one
 *   bad-lighting enrollment away from being someone else.
 *
 *   Replayed failures. Attempts that did not resolve to a user keep their probe
 *   embedding, so past failures can be re-scored against the enlarged gallery.
 *   If a face that failed to match anyone now matches a benchmark row, that is
 *   worth knowing before the gallery grows any further.
 */
const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;

const THRESHOLD = config.MATCH_THRESHOLD ?? 0.45;
const MARGIN = config.MATCH_MARGIN ?? 0.08;

/** Base64 of raw float32, the wire format the ML service uses for embeddings. */
function toVector(base64) {
  const raw = Buffer.from(base64, 'base64');
  const view = new Float32Array(raw.length / 4);
  for (let i = 0; i < view.length; i += 1) view[i] = raw.readFloatLE(i * 4);
  return view;
}

/** Both sides are unit vectors, so the dot product is the cosine similarity. */
function similarity(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
}

async function main() {
  await mongoose.connect(config.MONGODB_URI);

  // Built the same way a real verification builds it, so anything the pool
  // silently drops is dropped here too. Measuring against a gallery assembled
  // by different rules would report accuracy for a system nobody runs.
  const { gallery, undecryptable, narrowed, activeCount } = await buildCandidatePool({});

  if (undecryptable.length > 0) {
    console.error(`${undecryptable.length} rows failed to decrypt:`, undecryptable);
  }

  const meta = await User.find({ _id: { $in: gallery.map((g) => g.user_id) } })
    .select('displayName source benchmarkLabel enrollment')
    .lean();
  const byId = new Map(meta.map((u) => [String(u._id), u]));

  const entries = gallery.map((g) => ({
    id: g.user_id,
    vector: toVector(g.embedding_b64),
    ...(byId.get(g.user_id) ?? { source: 'live', displayName: '(unknown)' }),
  }));

  const live = entries.filter((e) => e.source !== 'benchmark');
  const benchmark = entries.filter((e) => e.source === 'benchmark');

  console.log(`active users        ${activeCount}`);
  console.log(`candidate pool      ${entries.length}${narrowed ? ' (narrowed)' : ''}`);
  console.log(`  live              ${live.length}`);
  console.log(`  benchmark         ${benchmark.length}`);
  console.log(`threshold           ${THRESHOLD}   margin ${MARGIN}`);

  if (benchmark.length === 0) {
    console.log(
      '\nNo benchmark rows loaded, so this is a gallery of real users only.\n' +
        'Run src/scripts/loadBenchmark.js first.',
    );
  }

  // ---- headroom, per enrolled person -------------------------------------
  console.log(`\nNearest impostor for each enrolled person\n`);
  console.log(
    `${'name'.padEnd(22)} ${'nearest'.padEnd(9)} ${'headroom'.padEnd(9)} who`,
  );
  console.log('─'.repeat(78));

  const headroom = [];

  for (const person of live) {
    let best = null;

    for (const other of entries) {
      if (other.id === person.id) continue;
      const score = similarity(person.vector, other.vector);
      if (best === null || score > best.score) best = { score, other };
    }

    if (!best) continue;

    const gap = THRESHOLD - best.score;
    headroom.push({
      name: person.displayName,
      userId: person.id,
      nearest: Number(best.score.toFixed(4)),
      headroom: Number(gap.toFixed(4)),
      nearestName: best.other.displayName,
      nearestSource: best.other.source ?? 'live',
      enrollmentAgreement: person.enrollment?.meanSimilarity ?? null,
    });

    const flag = best.score >= THRESHOLD ? '  <- ABOVE THRESHOLD' : '';
    console.log(
      `${person.displayName.slice(0, 21).padEnd(22)} ` +
        `${best.score.toFixed(4).padEnd(9)} ` +
        `${gap.toFixed(4).padEnd(9)} ` +
        `${best.other.displayName?.slice(0, 24) ?? '?'}` +
        ` (${best.other.source ?? 'live'})${flag}`,
    );
  }

  headroom.sort((a, b) => a.headroom - b.headroom);

  if (headroom.length > 0) {
    const worst = headroom[0];
    console.log(
      `\nTightest margin: ${worst.name} at ${worst.nearest} against ` +
        `${worst.nearestName}, ${worst.headroom} below the threshold.`,
    );
    if (worst.nearest >= THRESHOLD) {
      console.log(
        'That is a false match in a live gallery. Raise the threshold or ' +
          're-enrol the person, and do not treat this as a rounding problem.',
      );
    }
  }

  // ---- the impostor distribution across every live/benchmark pair ---------
  const cross = [];
  for (const person of live) {
    for (const other of benchmark) {
      cross.push(similarity(person.vector, other.vector));
    }
  }
  cross.sort((a, b) => a - b);

  let crossStats = null;
  if (cross.length > 0) {
    crossStats = {
      n: cross.length,
      median: Number(percentile(cross, 0.5).toFixed(4)),
      p99: Number(percentile(cross, 0.99).toFixed(4)),
      p999: Number(percentile(cross, 0.999).toFixed(4)),
      max: Number(cross[cross.length - 1].toFixed(4)),
      aboveThreshold: cross.filter((s) => s >= THRESHOLD).length,
    };

    console.log(
      `\nReal faces vs benchmark faces — ${cross.length.toLocaleString()} comparisons`,
    );
    console.log(`  median            ${crossStats.median}`);
    console.log(`  p99               ${crossStats.p99}`);
    console.log(`  p99.9             ${crossStats.p999}`);
    console.log(`  max               ${crossStats.max}`);
    console.log(
      `  at or above ${THRESHOLD}   ${crossStats.aboveThreshold}` +
        (crossStats.aboveThreshold === 0 ? '   (no false matches)' : '   <- false matches'),
    );
  }

  // ---- replay past failures against the enlarged gallery -----------------
  const failures = await VerificationLog.find({ probeEmbedding: { $ne: null } })
    .select('+probeEmbedding')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const replayed = [];
  for (const log of failures) {
    let probe;
    try {
      probe = toVector(decryptEmbedding(log.probeEmbedding).toString('base64'));
    } catch {
      continue;
    }

    const scored = entries
      .map((e) => ({ e, score: similarity(probe, e.vector) }))
      .sort((a, b) => b.score - a.score);

    const [top, second] = scored;
    const gap = top.score - (second?.score ?? 0);
    const decision =
      top.score < THRESHOLD ? 'no_match' : gap < MARGIN ? 'ambiguous' : 'matched';

    replayed.push({
      logId: String(log._id),
      wasOutcome: log.outcome,
      nowDecision: decision,
      nowTop: Number(top.score.toFixed(4)),
      nowMatch: top.e.displayName,
      nowSource: top.e.source ?? 'live',
    });
  }

  if (replayed.length > 0) {
    console.log(
      `\nReplaying ${replayed.length} past failed attempts against this gallery\n`,
    );
    const counts = {};
    for (const r of replayed) {
      const key = `${r.wasOutcome} -> ${r.nowDecision}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const [key, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key.padEnd(28)} ${count}`);
    }

    // An attempt whose verdict changed is the interesting one either way. A
    // failure that now matches means the person was enrollable all along and
    // the gallery was simply missing them at the time — which is the only
    // record we have of someone who walked away. A match that now fails means
    // growing the gallery took something away.
    const changed = replayed.filter((r) => r.wasOutcome !== r.nowDecision);
    if (changed.length > 0) {
      console.log(`\n  ${changed.length} changed verdict:`);
      for (const r of changed.slice(0, 20)) {
        console.log(
          `    ${r.logId}  ${r.wasOutcome} -> ${r.nowDecision}  ` +
            `${r.nowTop}  ${r.nowMatch} (${r.nowSource})`,
        );
      }
    }

    const nowMatchingBenchmark = replayed.filter(
      (r) => r.nowDecision === 'matched' && r.nowSource === 'benchmark',
    );
    if (nowMatchingBenchmark.length > 0) {
      console.log(
        `\n  ${nowMatchingBenchmark.length} of them now match a benchmark row. ` +
          'These are false matches created by growing the gallery:',
      );
      for (const r of nowMatchingBenchmark.slice(0, 10)) {
        console.log(`    ${r.logId}  ${r.nowTop}  ${r.nowMatch}`);
      }
    }
  } else {
    console.log(
      '\nNo stored probe embeddings to replay. They are kept only for attempts ' +
        'that did not resolve to a user.',
    );
  }

  if (jsonPath) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const out = resolve(jsonPath);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      out,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          gallery: { total: entries.length, live: live.length, benchmark: benchmark.length },
          thresholds: { match: THRESHOLD, margin: MARGIN },
          headroom,
          liveVsBenchmark: crossStats,
          replayedFailures: replayed,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\nWrote ${out}`);
  }
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
