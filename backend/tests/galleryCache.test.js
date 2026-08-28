import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { config } from '../src/config/index.js';
import { User } from '../src/models/User.js';
import { buildCandidatePool } from '../src/services/candidatePool.js';
import { encryptEmbedding } from '../src/services/encryption.js';
import * as galleryCache from '../src/services/galleryCache.js';

before(async () => {
  assert.ok(config.MONGODB_URI.includes('test'), 'refusing a non-test database');
  await mongoose.connect(config.MONGODB_URI);
});
after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => {
  await User.deleteMany({});
  galleryCache.clear();
});

let counter = 0;
async function makeUser(overrides = {}) {
  counter += 1;
  return User.create({
    displayName: `Subject ${counter}`,
    embedding: encryptEmbedding(randomBytes(512 * 4)),
    enrollment: { samplesUsed: 5, meanSimilarity: 0.9 },
    lastSeenAt: new Date(),
    ...overrides,
  });
}

describe('the cached gallery answers exactly as the database did', () => {
  it('returns an identical gallery cold and warm', async () => {
    // The whole safety argument in one assertion. If holding signatures in
    // memory changed *anything* about what identification is handed — a user
    // missing, an order shifted, one byte of one embedding different — the
    // accuracy numbers measured against the database path would no longer
    // describe the running system.
    for (let i = 0; i < 6; i += 1) await makeUser();

    galleryCache.clear();
    const fromDatabase = await buildCandidatePool({});

    // Second call touches no embedding row at all.
    const fromMemory = await buildCandidatePool({});

    assert.deepEqual(fromMemory.gallery, fromDatabase.gallery);
    assert.equal(fromMemory.activeCount, fromDatabase.activeCount);
    assert.equal(fromMemory.narrowed, fromDatabase.narrowed);
    assert.equal(fromMemory.gallery.length, 6);
  });

  it('still decides membership on every scan rather than caching the pool', async () => {
    // The mistake this rules out. Narrowing reads `lastSeenAt`,
    // `knownMerchants` and `homeRegion`, all of which move as people use the
    // system — so only the signatures are held, never the answer.
    const stale = await makeUser();
    await makeUser();

    await buildCandidatePool({});
    assert.equal(galleryCache.stats().held, 2, 'both signatures should be held');

    // Push one user outside the active window. Their embedding stays cached.
    stale.lastSeenAt = new Date(
      Date.now() - (config.CANDIDATE_POOL_ACTIVE_DAYS + 30) * 24 * 3600 * 1000,
    );
    await stale.save();

    const after = await buildCandidatePool({});
    assert.equal(after.gallery.length, 1, 'the inactive user must drop out');
    assert.ok(
      !after.gallery.some((row) => row.user_id === String(stale._id)),
      'a cached signature must not keep somebody in the pool',
    );
  });
});

describe('the cache lets go when it has to', () => {
  it('serves the new signature after somebody enrols again', async () => {
    const user = await makeUser();
    const first = await buildCandidatePool({});

    // What the enrollment controller does: write, then evict.
    user.embedding = encryptEmbedding(randomBytes(512 * 4));
    await user.save();
    galleryCache.evict(user._id);

    const second = await buildCandidatePool({});

    assert.notEqual(
      second.gallery[0].embedding_b64,
      first.gallery[0].embedding_b64,
      'a re-enrolled face must not keep matching against its old signature',
    );
  });

  it('drops a deleted face immediately, not when the TTL expires', async () => {
    const user = await makeUser();
    await makeUser();
    await buildCandidatePool({});

    // What deleteFaceData does.
    await User.deleteOne({ _id: user._id });
    galleryCache.evict(user._id);

    const remaining = await buildCandidatePool({});
    assert.equal(remaining.gallery.length, 1);
    assert.ok(
      !remaining.gallery.some((row) => row.user_id === String(user._id)),
      'a deleted face staying matchable would make the deletion a lie',
    );
  });

  it('reports an unreadable record and does not keep retrying it', async () => {
    await makeUser();
    // Ciphertext this key cannot open — a key rotation that left rows behind,
    // or a tampered row.
    const bad = await makeUser({ embedding: randomBytes(64) });

    const first = await buildCandidatePool({});
    assert.equal(first.gallery.length, 1);
    assert.equal(first.undecryptable.length, 1);
    assert.equal(first.undecryptable[0].userId, String(bad._id));

    const second = await buildCandidatePool({});
    assert.equal(second.gallery.length, 1);
    assert.equal(second.undecryptable.length, 1, 'still reported on a cache hit');
    assert.equal(galleryCache.stats().unreadable, 1);
  });
});
