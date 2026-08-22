import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { config } from '../src/config/index.js';
import { User } from '../src/models/User.js';
import {
  buildCandidatePool,
  recordSighting,
} from '../src/services/candidatePool.js';
import { encryptEmbedding } from '../src/services/encryption.js';

// test.env lowers this so narrowing can be exercised with a few users.
const NARROW_ABOVE = config.CANDIDATE_POOL_NARROW_ABOVE;

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
});

async function makeUser({
  displayName = 'Subject',
  homeRegion = null,
  knownMerchants = [],
  status = 'active',
  lastSeenAt = new Date(),
  embedding = encryptEmbedding(randomBytes(512 * 4)),
} = {}) {
  return User.create({
    displayName,
    embedding,
    enrollment: { samplesUsed: 5, meanSimilarity: 0.96 },
    homeRegion,
    knownMerchants,
    status,
    lastSeenAt,
  });
}

const idsIn = (pool) => pool.gallery.map((entry) => entry.user_id).sort();

describe('candidate pool', () => {
  it('includes everyone while the gallery is small', async () => {
    const a = await makeUser({ homeRegion: 'delhi' });
    const b = await makeUser({ homeRegion: 'mumbai' });

    const pool = await buildCandidatePool({ merchantId: 'shop-1', region: 'delhi' });

    assert.equal(pool.narrowed, false, 'narrowing must not engage at this size');
    assert.deepEqual(idsIn(pool), [String(a._id), String(b._id)].sort());
  });

  it('decrypts each embedding into a full-length vector', async () => {
    await makeUser();
    const pool = await buildCandidatePool({ merchantId: 'shop-1' });

    assert.equal(
      Buffer.from(pool.gallery[0].embedding_b64, 'base64').length,
      512 * 4,
    );
  });

  it('still finds a newly enrolled user once narrowing engages', async () => {
    // The case that deadlocks the whole system if it is missed. A user who
    // enrolled minutes ago has no home region and has never paid anywhere, so
    // a pure locality filter drops them from every pool — and since the only
    // way into `knownMerchants` is to be identified, they could never be
    // identified at any merchant, ever.
    for (let i = 0; i <= NARROW_ABOVE; i += 1) {
      await makeUser({ homeRegion: 'mumbai', knownMerchants: ['shop-9'] });
    }
    const fresh = await makeUser();

    const pool = await buildCandidatePool({ merchantId: 'shop-1', region: 'delhi' });

    assert.equal(pool.narrowed, true, 'this test is pointless without narrowing');
    assert.ok(
      idsIn(pool).includes(String(fresh._id)),
      'a user with no locality yet must stay in every pool',
    );
  });

  it('includes a regular of this merchant even from another region', async () => {
    for (let i = 0; i <= NARROW_ABOVE; i += 1) {
      await makeUser({ homeRegion: 'chennai', knownMerchants: ['shop-9'] });
    }
    const regular = await makeUser({
      homeRegion: 'mumbai',
      knownMerchants: ['shop-1'],
    });

    const pool = await buildCandidatePool({ merchantId: 'shop-1', region: 'delhi' });

    assert.ok(idsIn(pool).includes(String(regular._id)));
  });

  it('includes a local who has never visited this merchant', async () => {
    for (let i = 0; i <= NARROW_ABOVE; i += 1) {
      await makeUser({ homeRegion: 'chennai', knownMerchants: ['shop-9'] });
    }
    const local = await makeUser({
      homeRegion: 'delhi',
      knownMerchants: ['shop-4'],
    });

    const pool = await buildCandidatePool({ merchantId: 'shop-1', region: 'delhi' });

    assert.ok(idsIn(pool).includes(String(local._id)));
  });

  it('excludes suspended users', async () => {
    await makeUser({ status: 'suspended' });
    const active = await makeUser();

    const pool = await buildCandidatePool({ merchantId: 'shop-1' });

    assert.deepEqual(idsIn(pool), [String(active._id)]);
  });

  it('excludes users who have not been seen for a long time', async () => {
    const stale = new Date(
      Date.now() - (config.CANDIDATE_POOL_ACTIVE_DAYS + 30) * 86_400_000,
    );
    await makeUser({ lastSeenAt: stale });
    const recent = await makeUser();

    const pool = await buildCandidatePool({ merchantId: 'shop-1' });

    assert.deepEqual(idsIn(pool), [String(recent._id)]);
  });

  it('skips an unreadable record instead of failing the whole pool', async () => {
    // One corrupt row — or one left behind by a key rotation — must not take
    // down every verification at the terminal.
    await makeUser({ embedding: Buffer.from('not a valid ciphertext at all') });
    const healthy = await makeUser();

    const pool = await buildCandidatePool({ merchantId: 'shop-1' });

    assert.deepEqual(idsIn(pool), [String(healthy._id)]);
    assert.equal(pool.undecryptable.length, 1, 'the failure must be reported');
  });
});

describe('recordSighting', () => {
  it('remembers the merchant so later pools can use it', async () => {
    const user = await makeUser();

    await recordSighting(user._id, { merchantId: 'shop-1', region: 'delhi' });
    const updated = await User.findById(user._id).lean();

    assert.deepEqual(updated.knownMerchants, ['shop-1']);
    assert.equal(updated.homeRegion, 'delhi');
  });

  it('does not duplicate a merchant already recorded', async () => {
    const user = await makeUser({ knownMerchants: ['shop-1'] });

    await recordSighting(user._id, { merchantId: 'shop-1' });
    const updated = await User.findById(user._id).lean();

    assert.deepEqual(updated.knownMerchants, ['shop-1']);
  });

  it('advances lastSeenAt so the user stays in the active window', async () => {
    const old = new Date(Date.now() - 86_400_000);
    const user = await makeUser({ lastSeenAt: old });

    await recordSighting(user._id, { merchantId: 'shop-1' });
    const updated = await User.findById(user._id).lean();

    assert.ok(updated.lastSeenAt > old);
  });
});
