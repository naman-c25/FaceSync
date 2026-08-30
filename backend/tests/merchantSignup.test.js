import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Merchant } from '../src/models/Merchant.js';
import { hashPassword } from '../src/services/merchantAuth.js';
import { createTestContext } from './helpers/context.js';

let ctx;

before(async () => {
  ctx = await createTestContext();
});
after(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

const signUp = (overrides = {}) =>
  ctx.request('POST', '/api/merchant/register', {
    name: 'Corner Store',
    email: 'corner@shop.test',
    password: 'a-long-enough-one',
    ...overrides,
  });

describe('a shop can open its own account', () => {
  it('creates it, signs them in, and marks it unapproved', async () => {
    const response = await signUp();

    assert.equal(response.status, 201);
    assert.ok(response.body.token, 'should be signed in straight away');
    assert.equal(response.body.merchant.verified, false);
    assert.equal(response.body.merchant.role, 'merchant');

    const stored = await Merchant.findOne({ email: 'corner@shop.test' });
    assert.equal(stored.verified, false);
    assert.equal(stored.role, 'merchant', 'signing up must not confer admin');
  });

  it('gives every shop an id nobody else can claim', async () => {
    // The id is stamped on every transaction and sits in every customer's
    // knownMerchants, so it cannot be swapped later. Deriving it from the name
    // alone would let the first person to sign up as "Corner Store" take the
    // id the real one would want.
    const first = await signUp();
    const second = await signUp({ email: 'other@shop.test' });

    assert.notEqual(
      first.body.merchant.merchantId,
      second.body.merchant.merchantId,
    );
    assert.ok(first.body.merchant.merchantId.startsWith('corner-store-'));
  });

  it('turns away a second account on the same email', async () => {
    await signUp();
    const again = await signUp({ name: 'Someone Else' });

    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'email_taken');
  });

  it('will not take a short password', async () => {
    const response = await signUp({ password: 'short' });
    assert.equal(response.status, 400);
  });
});

/** Open a scan as a signed-in shop. The id comes from the token, never the body. */
const scanAs = (token) =>
  fetch(`${ctx.baseUrl}/api/merchant/verify/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ deviceId: 'till-1' }),
  });

describe('an unapproved terminal cannot look at anybody', () => {
  it('refuses to open a camera session', async () => {
    // The gate is here rather than at the charge on purpose. Taking money
    // already needs the customer's own PIN; what an unapproved shop must not
    // be able to do is point a camera at a queue and be told everyone's name.
    const shop = await signUp();

    const started = await scanAs(shop.body.token);
    const body = await started.json();

    assert.equal(started.status, 403);
    assert.equal(body.error.code, 'terminal_not_verified');
  });

  it('cannot get around it by naming a different shop', async () => {
    // The reason the terminal id moved out of the request body. When the check
    // read `merchantId` from what was posted, an unapproved shop simply sent
    // the kiosk's id and scanned customers anyway -- the gate was asking the
    // caller which identity to check them against.
    const shop = await signUp();
    assert.equal((await scanAs(shop.body.token)).status, 403);

    // The public route accepts no shop id at all any more, so there is nothing
    // to substitute: whatever is sent, the session is the kiosk's own.
    const kiosk = await ctx.request('POST', '/api/verify/start', {
      merchantId: shop.body.merchant.merchantId,
      deviceId: 'kiosk-1',
    });
    assert.equal(kiosk.status, 201);

    const { Session } = await import('../src/models/Session.js');
    const session = await Session.findById(kiosk.body.sessionId);
    assert.equal(
      session.merchantId,
      'demo-shop',
      'the kiosk must book to its own id, not one it was handed',
    );
  });

  it('lets it through once it is approved', async () => {
    const shop = await signUp();

    const record = await Merchant.findOne({ email: 'corner@shop.test' });
    record.verified = true;
    await record.save();

    assert.equal((await scanAs(shop.body.token)).status, 201);
  });

  it('turns away a scan with no merchant token at all', async () => {
    const started = await fetch(`${ctx.baseUrl}/api/merchant/verify/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'till-1' }),
    });
    assert.equal(started.status, 401);
  });

  it('leaves the public kiosk working', async () => {
    const started = await ctx.request('POST', '/api/verify/start', {
      deviceId: 'kiosk-1',
    });
    assert.equal(started.status, 201);
  });

  it('leaves accounts made from the command line approved', async () => {
    // `verified` defaults to true so that every account that existed before
    // this feature, and every one created administratively, keeps working
    // without a migration.
    const seeded = await Merchant.create({
      merchantId: 'seeded-shop',
      name: 'Seeded',
      email: 'seeded@shop.test',
      passwordHash: hashPassword('a-long-enough-one'),
    });
    assert.equal(seeded.verified, true);

    const { body } = await ctx.request('POST', '/api/merchant/login', {
      email: 'seeded@shop.test',
      password: 'a-long-enough-one',
    });
    assert.equal((await scanAs(body.token)).status, 201);
  });
});

/**
 * Which area a scan searches first.
 *
 * The region narrows the candidate pool, and a smaller pool is a proportionally
 * smaller false-match rate -- system FMR grows as N x the per-comparison rate.
 * So it is worth getting right, and worth taking from somewhere the caller
 * cannot choose.
 */
describe('a terminal knows its own area', () => {
  it('takes the region from the shop record, not the request', async () => {
    // It used to arrive in the request body: the till read it from /me and
    // posted it back. That made a value the server already held into a value
    // the caller supplied -- the same shape as the shop id, which is how an
    // unapproved terminal once scanned customers.
    const shop = await signUp();
    const record = await Merchant.findOne({ email: 'corner@shop.test' });
    record.verified = true;
    record.region = 'sector-18';
    await record.save();

    const started = await fetch(`${ctx.baseUrl}/api/merchant/verify/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shop.body.token}`,
      },
      // Deliberately asking for somewhere else.
      body: JSON.stringify({ deviceId: 'till-1', region: 'somewhere-else' }),
    });
    assert.equal(started.status, 201);

    const { Session } = await import('../src/models/Session.js');
    const session = await Session.findById((await started.json()).sessionId);

    assert.equal(
      session.region,
      'sector-18',
      'the session took the region the caller asked for',
    );
  });

  it('is happy with no region at all', async () => {
    // Null is a working answer: the shop still narrows by its own repeat
    // customers, and a pool that does not narrow is correct, only larger.
    const shop = await signUp();
    const record = await Merchant.findOne({ email: 'corner@shop.test' });
    record.verified = true;
    await record.save();

    const started = await scanAs(shop.body.token);
    assert.equal(started.status, 201);

    const { Session } = await import('../src/models/Session.js');
    const session = await Session.findById((await started.json()).sessionId);
    assert.equal(session.region, null);
  });

  it('records the region against a customer it recognises', async () => {
    // The half of this that was already working was `knownMerchants`; the
    // region was never written because nothing ever supplied one. This is what
    // makes a customer a local rather than only a regular of one shop.
    const { User } = await import('../src/models/User.js');
    const { recordSighting } = await import('../src/services/candidatePool.js');

    const user = await User.create({
      displayName: 'Local Person',
      embedding: Buffer.alloc(2077),
      enrollment: { samplesUsed: 5, meanSimilarity: 0.96 },
    });
    assert.equal(user.homeRegion, null, 'nobody starts with a region');

    await recordSighting(user._id, { merchantId: 'corner-store', region: 'sector-18' });

    const seen = await User.findById(user._id).lean();
    assert.equal(seen.homeRegion, 'sector-18');
    assert.deepEqual(seen.knownMerchants, ['corner-store']);
  });
});
