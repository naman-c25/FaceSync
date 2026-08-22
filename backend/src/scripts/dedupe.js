import mongoose from 'mongoose';

import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { VerificationLog } from '../models/VerificationLog.js';
import { buildCandidatePool } from '../services/candidatePool.js';
import { mlService } from '../services/mlServiceClient.js';

/**
 * Collapse duplicate registrations of the same face.
 *
 * Enrollment now recognises a returning face and updates its record rather
 * than adding a second one, but any duplicates created before that stay put —
 * and they are not harmless. Two entries for one person sit well inside the
 * match margin of each other, so every attempt by that person comes back
 * `ambiguous` and they can never be identified.
 *
 *     node src/scripts/dedupe.js            # report only
 *     node src/scripts/dedupe.js --apply    # actually delete
 *
 * The newest record in each group is kept, on the assumption that a repeat
 * registration was an attempt to improve on the last one.
 */
const THRESHOLD = config.MATCH_THRESHOLD ?? 0.45;
const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(config.MONGODB_URI);
  const { gallery } = await buildCandidatePool({});

  if (gallery.length < 2) {
    console.log('Fewer than two enrolled users — nothing to compare.');
    return;
  }

  const users = await User.find({ _id: { $in: gallery.map((g) => g.user_id) } })
    .sort({ createdAt: 1 })
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  // Union-find over "these two are the same face", so a chain of three
  // registrations collapses into one group rather than two overlapping pairs.
  const parent = new Map(gallery.map((g) => [g.user_id, g.user_id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  const union = (a, b) => parent.set(find(a), find(b));

  for (const entry of gallery) {
    const others = gallery.filter((g) => g.user_id !== entry.user_id);
    const result = await mlService.compare(entry.embedding_b64, others);

    for (const candidate of result.candidates) {
      if (candidate.score >= THRESHOLD) union(entry.user_id, candidate.user_id);
    }
  }

  const groups = new Map();
  for (const entry of gallery) {
    const root = find(entry.user_id);
    groups.set(root, [...(groups.get(root) ?? []), entry.user_id]);
  }

  const duplicates = [...groups.values()].filter((ids) => ids.length > 1);

  if (duplicates.length === 0) {
    console.log(`${gallery.length} users, no duplicates found.`);
    return;
  }

  const doomed = [];

  for (const ids of duplicates) {
    // Newest wins: a repeat registration is usually an attempt at a better one.
    const members = ids
      .map((id) => byId.get(id))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const [keep, ...drop] = members;
    console.log(`\nSame face registered ${members.length} times:`);
    console.log(
      `  KEEP  ${keep.displayName.padEnd(24)} ${keep._id}  ` +
        `${new Date(keep.createdAt).toLocaleString()}`,
    );
    for (const user of drop) {
      console.log(
        `  DROP  ${user.displayName.padEnd(24)} ${user._id}  ` +
          `${new Date(user.createdAt).toLocaleString()}`,
      );
      doomed.push({ from: user._id, to: keep._id });
    }
  }

  if (!apply) {
    console.log(`\n${doomed.length} records would be removed.`);
    console.log('Re-run with --apply to do it.');
    return;
  }

  for (const { from, to } of doomed) {
    // Point past attempts at the surviving record first. Deleting the user out
    // from under its own audit rows would leave logs referencing an id that no
    // longer resolves, and those rows are the FAR/FRR dataset.
    await VerificationLog.updateMany({ matchedUser: from }, { $set: { matchedUser: to } });
    await User.deleteOne({ _id: from });
  }

  console.log(`\nRemoved ${doomed.length} duplicate records.`);
  console.log(`${await User.countDocuments()} users remain.`);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
