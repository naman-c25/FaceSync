import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Merchant } from '../src/models/Merchant.js';
import { User } from '../src/models/User.js';
import { VerificationLog } from '../src/models/VerificationLog.js';
import { buildCandidatePool } from '../src/services/candidatePool.js';
import { hashPassword } from '../src/services/merchantAuth.js';
import { createTestContext, FAKE_FRAME } from './helpers/context.js';

let ctx;

before(async () => {
  ctx = await createTestContext();
});
after(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
  tokens.clear();
});

async function enrol({ displayName, merchantId, region } = {}) {
  const start = await ctx.request('POST', '/api/enroll/start', {
    displayName,
    merchantId,
    region,
  });
  for (let i = 0; i < 5; i += 1) {
    await ctx.request('POST', '/api/enroll/capture', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });
  }
  const done = await ctx.request('POST', '/api/enroll/finalize', {
    sessionId: start.body.sessionId,
    pin: '4827',
  });
  return done.body.userId;
}

/**
 * A signed-in shop.
 *
 * Needed because a scan is booked to the shop in its token now, not to a
 * merchant id in the request body -- otherwise any caller could name any shop.
 */
const tokens = new Map();
async function shopToken(merchantId) {
  if (tokens.has(merchantId)) return tokens.get(merchantId);

  const email = `${merchantId}@test.shop`;
  await Merchant.create({
    merchantId,
    name: merchantId,
    email,
    passwordHash: hashPassword('a-long-enough-one'),
  });
  const { body } = await ctx.request('POST', '/api/merchant/login', {
    email,
    password: 'a-long-enough-one',
  });

  tokens.set(merchantId, body.token);
  return body.token;
}

async function identify({ merchantId, region } = {}) {
  const token = await shopToken(merchantId ?? 'kiosk-shop');
  const started = await fetch(`${ctx.baseUrl}/api/merchant/verify/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ region }),
  }).then((r) => r.json());
  const start = { body: started };

  ctx.ml.state.livenessOutcome = 'passed';
  await ctx.request('POST', '/api/verify/frame', {
    sessionId: start.body.sessionId,
    frames: [{ image: FAKE_FRAME, capturedAtMs: 0 }],
  });

  return ctx.request('POST', '/api/verify/match', { sessionId: start.body.sessionId });
}

/**
 * The test env sets CANDIDATE_POOL_NARROW_ABOVE=2, so three users is enough to
 * make narrowing engage without loading two thousand.
 */
async function fillPastNarrowingThreshold() {
  for (let i = 0; i < 3; i += 1) {
    await User.create({
      displayName: `Filler ${i}`,
      embedding: Buffer.alloc(64, i + 1),
      enrollment: { samplesUsed: 5, meanSimilarity: 0.95 },
      homeRegion: 'somewhere-else',
      knownMerchants: ['other-shop'],
      source: 'live',
    });
  }
}

describe('a registered customer at a shop they have never used', () => {
  it('is left out of the narrowed pool', async () => {
    // The bug itself, pinned. Paying anywhere at all writes a `knownMerchants`
    // entry, and having one disqualifies you from the "no locality yet" clause
    // — so from your second shop onwards you are outside every narrowed pool
    // but your own regulars'. Visiting a new shop is not an edge case.
    const userId = await enrol({ displayName: 'Regular', merchantId: 'shop-a' });
    await fillPastNarrowingThreshold();

    const narrow = await buildCandidatePool({ merchantId: 'shop-b' });
    assert.equal(narrow.narrowed, true, 'narrowing did not engage');
    assert.ok(
      !narrow.gallery.some((g) => g.user_id === userId),
      'the premise of this test no longer holds',
    );

    const wide = await buildCandidatePool({ merchantId: 'shop-b', narrow: false });
    assert.ok(wide.gallery.some((g) => g.user_id === userId));
  });

  it('is still identified, because the search widens on a miss', async () => {
    const userId = await enrol({ displayName: 'Regular', merchantId: 'shop-a' });
    await fillPastNarrowingThreshold();

    // The narrow pool does not contain them, so the first pass finds nothing.
    // The second pass, over everyone, does.
    ctx.ml.state.matchDecision = 'no_match';
    ctx.ml.state.duplicateScore = 0.91;
    ctx.ml.state.compareUserId = userId;

    const { status, body } = await identify({ merchantId: 'shop-b' });

    assert.equal(status, 200);
    assert.equal(body.decision, 'matched');
    assert.equal(body.user.userId, userId);
  });

  it('records that the widened pass is what found them', async () => {
    // Without this the only symptom of a bad narrowing rule is customers being
    // told to register again, which nobody reports and nothing measures.
    const userId = await enrol({ displayName: 'Regular', merchantId: 'shop-a' });
    await fillPastNarrowingThreshold();

    ctx.ml.state.matchDecision = 'no_match';
    ctx.ml.state.duplicateScore = 0.91;
    ctx.ml.state.compareUserId = userId;

    await identify({ merchantId: 'shop-b' });

    const log = await VerificationLog.findOne().sort({ createdAt: -1 });
    assert.equal(log.poolNarrowed, true);
    assert.equal(log.poolWidened, true);
  });

  it('keeps the liveness evidence from the first pass', async () => {
    // The widened pass runs through `compare`, which knows nothing about the
    // session the probe came from. If the signals were not carried over, a
    // widened match would leave an audit row that could not say whether a live
    // person was ever in front of the camera.
    const userId = await enrol({ displayName: 'Regular', merchantId: 'shop-a' });
    await fillPastNarrowingThreshold();

    ctx.ml.state.matchDecision = 'no_match';
    ctx.ml.state.duplicateScore = 0.91;
    ctx.ml.state.compareUserId = userId;

    await identify({ merchantId: 'shop-b' });

    const log = await VerificationLog.findOne().sort({ createdAt: -1 });
    assert.equal(log.liveness.passed, true);
    assert.equal(log.liveness.blinksDetected, 2);
    assert.ok(log.liveness.challenge.length > 0);
  });
});

describe('widening does not widen everything', () => {
  it('leaves an ambiguous result alone', async () => {
    // Ambiguity means the pool already held two faces too close to separate.
    // Throwing thousands more candidates at that can only produce more ties,
    // and turning "I cannot tell who this is" into a match by enlarging the
    // haystack would be the worst possible reading of the two-condition rule.
    await enrol({ displayName: 'Regular', merchantId: 'shop-a' });
    await fillPastNarrowingThreshold();

    ctx.ml.state.matchDecision = 'ambiguous';

    const { body } = await identify({ merchantId: 'shop-b' });

    assert.equal(body.decision, 'ambiguous');
    const log = await VerificationLog.findOne().sort({ createdAt: -1 });
    assert.equal(log.poolWidened, false);
  });

  it('does not run a second pass when the pool was never narrowed', async () => {
    // One user, so narrowing does not engage and the first pool is already
    // everyone. A second identical pass would just double the work.
    await enrol({ displayName: 'Only One', merchantId: 'shop-a' });

    ctx.ml.state.matchDecision = 'no_match';
    const before = ctx.ml.state.requests.length;

    await identify({ merchantId: 'shop-b' });

    const compares = ctx.ml.state.requests
      .slice(before)
      .filter((r) => r.key === 'POST /compare');
    assert.equal(compares.length, 0);
  });

  it('still reports no match when nobody matches at all', async () => {
    await enrol({ displayName: 'Regular', merchantId: 'shop-a' });
    await fillPastNarrowingThreshold();

    ctx.ml.state.matchDecision = 'no_match';
    ctx.ml.state.duplicateScore = 0.04; // the wider pass finds nothing either

    const { body } = await identify({ merchantId: 'shop-b' });

    assert.equal(body.decision, 'no_match');
    const log = await VerificationLog.findOne().sort({ createdAt: -1 });
    assert.equal(log.poolWidened, false);
    assert.ok(log.probeEmbedding !== null, 'an unresolved attempt kept no probe');
  });
});
