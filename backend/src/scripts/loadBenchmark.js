import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

import mongoose from 'mongoose';

import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { encryptEmbedding } from '../services/encryption.js';

/**
 * Load benchmark faces into the gallery, so 1:N can be measured at a real size.
 *
 *     node src/scripts/loadBenchmark.js ../benchmark-data/gallery.jsonl
 *     node src/scripts/loadBenchmark.js ../benchmark-data/gallery.jsonl --limit 2000
 *     node src/scripts/loadBenchmark.js --clear
 *
 * Input is what `ml-service/tools/embed_dataset.py` writes: one JSON object per
 * line, carrying a base64 512-d embedding and the label it came from.
 *
 * What these rows are for
 * -----------------------
 * A gallery of eight people cannot answer the question this system rests on.
 * The false match rate of the whole system grows roughly as N x the rate of a
 * single comparison, so "nobody was falsely matched against seven other people"
 * says almost nothing about what happens at two thousand. These rows make every
 * real customer compete against a realistic crowd, and the honest version of
 * that measurement is the point of the exercise.
 *
 * What these rows are not
 * -----------------------
 * They are not customers. Nobody in a research dataset agreed to be part of a
 * payment system, and the code treats them accordingly: they are stored with
 * `source: 'benchmark'`, they have no PIN, and both places where an identity
 * turns into a consequence refuse them by name — `paymentController.charge`
 * will not charge one, and enrollment will not collapse a real registration
 * into one. They exist to be compared against and nothing else.
 *
 * Storage is identical to a live user otherwise. The embeddings are encrypted
 * with the same key through the same code path, because a benchmark that
 * skipped the encryption would not be exercising the system that actually runs.
 */
const args = process.argv.slice(2);
const clear = args.includes('--clear');
const dryRun = args.includes('--dry-run');

const limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

// Everything that is neither a flag nor the value belonging to one.
const limitValueIndex = limitIndex >= 0 ? limitIndex + 1 : -1;
const file = args.find(
  (arg, i) => !arg.startsWith('--') && i !== limitValueIndex,
);

// Back-dated by a day so that live users, who are seen today, sort ahead of
// benchmark rows in the candidate pool. It changes nothing while the whole
// gallery fits under CANDIDATE_POOL_MAX, and if it ever stops fitting, the rows
// dropped first should be the ones that are not real customers.
const SEEN_AT = new Date(Date.now() - 24 * 60 * 60 * 1000);

// Written in batches rather than one at a time: two thousand round trips to a
// hosted Atlas cluster is minutes of latency for no reason.
const BATCH_SIZE = 250;

async function flush(batch) {
  if (batch.length === 0 || dryRun) return;

  // Keyed on the label so a re-run updates rather than duplicating. A gallery
  // that silently doubled every time this was run would put two copies of each
  // benchmark face inside the match margin of each other — the same failure
  // that duplicate live registrations cause.
  await User.bulkWrite(
    batch.map((row) => ({
      updateOne: {
        filter: { source: 'benchmark', benchmarkLabel: row.label },
        update: {
          $set: {
            displayName: row.displayName,
            embedding: row.embedding,
            enrollment: row.enrollment,
            source: 'benchmark',
            benchmarkLabel: row.label,
            status: 'active',
            lastSeenAt: SEEN_AT,
            homeRegion: null,
            knownMerchants: [],
            pinHash: null,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function main() {
  await mongoose.connect(config.MONGODB_URI);

  if (clear) {
    const { deletedCount } = await User.deleteMany({ source: 'benchmark' });
    console.log(`Removed ${deletedCount} benchmark rows.`);
    return;
  }

  if (!file) {
    console.error(
      'Usage: node src/scripts/loadBenchmark.js <gallery.jsonl> [--limit N] [--dry-run]\n' +
        '       node src/scripts/loadBenchmark.js --clear',
    );
    process.exitCode = 1;
    return;
  }

  const path = resolve(file);
  console.log(`Reading ${path}`);
  if (dryRun) console.log('Dry run — nothing will be written.\n');

  const reader = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });

  let read = 0;
  let written = 0;
  let malformed = 0;
  let batch = [];

  for await (const line of reader) {
    if (!line.trim()) continue;
    if (read >= limit) break;
    read += 1;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }

    const raw = Buffer.from(row.embedding_b64 ?? '', 'base64');

    // 512 floats at 4 bytes each. Checked because a truncated or wrongly typed
    // vector would still encrypt and store fine, and would then quietly skew
    // every score measured against it.
    if (!row.label || raw.length !== 512 * 4) {
      malformed += 1;
      continue;
    }

    batch.push({
      label: row.label,
      // The underscores are how the dataset names directories, not how anyone
      // writes their name.
      displayName: String(row.label).replaceAll('_', ' '),
      embedding: encryptEmbedding(raw),
      enrollment: {
        samplesUsed: row.enrollment?.samplesUsed ?? 1,
        meanSimilarity: row.enrollment?.meanSimilarity ?? 1,
        outliersDropped: row.enrollment?.outliersDropped ?? 0,
        completedAt: SEEN_AT,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await flush(batch);
      written += batch.length;
      batch = [];
      process.stdout.write(`  ${written} loaded\r`);
    }
  }

  await flush(batch);
  written += batch.length;

  // Users enrolled before `source` existed have no such field at all — a
  // schema default applies on write, not retroactively. They are live users,
  // and saying so explicitly keeps every later query from having to remember
  // that "not benchmark" and "source is live" are different tests.
  const backfilled = await User.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'live' } },
  );
  if (backfilled.modifiedCount > 0) {
    console.log(`\nMarked ${backfilled.modifiedCount} pre-existing users as live.`);
  }

  const totals = await User.aggregate([
    { $group: { _id: { $ifNull: ['$source', 'live'] }, count: { $sum: 1 } } },
  ]);

  console.log(`\nRead ${read} rows, loaded ${written}.`);
  if (malformed > 0) console.log(`Skipped ${malformed} malformed rows.`);

  console.log('\nGallery now holds:');
  for (const { _id, count } of totals.sort((a, b) => a._id.localeCompare(b._id))) {
    console.log(`  ${String(_id ?? 'live').padEnd(12)} ${count}`);
  }

  const total = totals.reduce((sum, t) => sum + t.count, 0);
  if (total > config.CANDIDATE_POOL_MAX) {
    console.log(
      `\nWarning: ${total} users exceeds CANDIDATE_POOL_MAX (${config.CANDIDATE_POOL_MAX}),\n` +
        'so a verification will not actually be compared against all of them.',
    );
  }
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
