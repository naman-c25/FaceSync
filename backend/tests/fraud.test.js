import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { FraudFlag } from '../src/models/FraudFlag.js';
import { Merchant } from '../src/models/Merchant.js';
import { VerificationLog } from '../src/models/VerificationLog.js';
import { evaluate } from '../src/services/fraudRuleEngine.js';
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

const T0 = new Date('2026-08-24T10:00:00Z');
const at = (secondsIn) => new Date(T0.getTime() + secondsIn * 1000);

/**
 * Write one verification-log row at a chosen moment.
 *
 * Inserted through the driver rather than the model because `timestamps: true`
 * overwrites `createdAt` on save, and every rule here is about *when* things
 * happened. The returned object is what the engine would be handed.
 */
async function attempt({
  outcome = 'liveness_failed',
  deviceId = 'kiosk-a',
  matchedUser = null,
  failureReason = 'face_lost',
  pinOutcome = null,
  when: happenedAt = T0,
} = {}) {
  const doc = {
    sessionId: 'session-1',
    attemptNumber: 1,
    merchantId: 'demo-shop',
    deviceId,
    outcome,
    matchedUser,
    pinOutcome,
    liveness: { passed: false, failureReason },
    createdAt: happenedAt,
    updatedAt: happenedAt,
  };
  const { insertedId } = await VerificationLog.collection.insertOne(doc);
  return { ...doc, _id: insertedId };
}

/** Run `count` attempts a few seconds apart and evaluate every one. */
async function burst(count, options = {}) {
  let last = [];
  for (let i = 0; i < count; i += 1) {
    const row = await attempt({ ...options, when: at(i * 10) });
    last = await evaluate(row);
  }
  return last;
}

describe('fraud rules: when they fire', () => {
  it('stays quiet below the threshold', async () => {
    const flags = await burst(2, { outcome: 'pin_failed', pinOutcome: 'wrong_pin' });

    assert.equal(flags.length, 0);
    assert.equal(await FraudFlag.countDocuments(), 0);
  });

  it('fires on the attempt that reaches it', async () => {
    const flags = await burst(3, { outcome: 'pin_failed', pinOutcome: 'wrong_pin' });

    assert.equal(flags.length, 1);
    assert.equal(flags[0].rule, 'pin_velocity');
    assert.equal(flags[0].severity, 'high_risk');
    assert.equal(flags[0].count, 3);
  });

  it('treats a long burst as one incident rather than one flag per attempt', async () => {
    // The reason this rule exists. A rolling window keeps firing for as long as
    // a terminal stays over the threshold -- run against the real log, one run
    // of failures fired 34 times. Thirty-four rows describing one event buries
    // the next real thing.
    await burst(12, { outcome: 'pin_failed', pinOutcome: 'wrong_pin' });

    const flags = await FraudFlag.find({ rule: 'pin_velocity' });
    assert.equal(flags.length, 1, 'a burst should collapse into a single flag');
    assert.equal(flags[0].count, 12, 'and that flag should carry the true count');
  });

  it('forgets attempts that fall out of the window', async () => {
    await evaluate(await attempt({ outcome: 'pin_failed', when: at(0) }));
    await evaluate(await attempt({ outcome: 'pin_failed', when: at(30) }));
    // Six minutes after the first, so only two attempts are inside any
    // five-minute window that contains it.
    const flags = await evaluate(await attempt({ outcome: 'pin_failed', when: at(360) }));

    assert.equal(flags.length, 0);
  });

  it('counts each terminal separately', async () => {
    await evaluate(await attempt({ outcome: 'pin_failed', deviceId: 'kiosk-a' }));
    await evaluate(await attempt({ outcome: 'pin_failed', deviceId: 'kiosk-a', when: at(10) }));
    // Third failure, different counter. Nothing has happened three times
    // anywhere, and merging them would make every terminal in the estate look
    // like one very busy one.
    const flags = await evaluate(
      await attempt({ outcome: 'pin_failed', deviceId: 'kiosk-b', when: at(20) }),
    );

    assert.equal(flags.length, 0);
  });

  it('ignores a log with no terminal on it', async () => {
    const orphan = await attempt({ outcome: 'pin_failed', deviceId: null });
    assert.deepEqual(await evaluate(orphan), []);
  });
});

describe('fraud rules: what they will and will not claim', () => {
  it('names who was targeted when the face was already identified', async () => {
    const userId = new VerificationLog().id; // any ObjectId shape will do
    const flags = await burst(3, {
      outcome: 'pin_failed',
      pinOutcome: 'wrong_pin',
      matchedUser: userId,
    });

    assert.equal(String(flags[0].matchedUser), String(userId));
  });

  it('refuses to name anyone on failures that happen before identification', async () => {
    // Liveness runs before matching, so these attempts genuinely have no
    // identity attached. Attaching one would mean storing a face signature
    // from every failed attempt.
    const flags = await burst(3, { failureReason: 'presentation_attack:screen photo' });

    assert.equal(flags.length, 1);
    assert.equal(flags[0].rule, 'spoof_burst');
    assert.equal(flags[0].matchedUser, null);
  });

  it('separates deliberate attacks from ordinary liveness failures', async () => {
    await burst(6, { failureReason: 'presentation_attack:screen photo' });

    const rules = (await FraudFlag.find()).map((flag) => flag.rule);
    assert.deepEqual(
      rules,
      ['spoof_burst'],
      'a spoof burst should not also be reported as generic liveness noise',
    );
  });

  it('does not treat a run of bad light as an attack', async () => {
    // `face_lost` is what a backlit person looks like. Five of them raise the
    // low-severity flag for a human to glance at; none of them raise the
    // attack flag.
    await burst(5, { failureReason: 'face_lost' });

    const flags = await FraudFlag.find();
    assert.equal(flags.length, 1);
    assert.equal(flags[0].rule, 'liveness_velocity');
    assert.equal(flags[0].severity, 'review');
  });

  it('needs five of them, not three', async () => {
    // Measured, not chosen: three-in-five-minutes fired 34 times across 205
    // real logs that were all legitimate testing.
    await burst(4, { failureReason: 'face_lost' });
    assert.equal(await FraudFlag.countDocuments(), 0);
  });
});

describe('the fraud dashboard', () => {
  async function account(role) {
    const email = `${role}@facesync.test`;
    await Merchant.create({
      merchantId: role,
      name: role,
      email,
      passwordHash: hashPassword('correct horse'),
      role,
    });

    const login = await ctx.request('POST', '/api/merchant/login', {
      email,
      password: 'correct horse',
    });
    return login.body.token;
  }

  const call = (token, method, path, body) =>
    fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('will not show one shop the failures of every other', async () => {
    const response = await call(await account('merchant'), 'GET', '/api/fraud/flags');
    assert.equal(response.status, 403);
  });

  it('turns nobody away without a token', async () => {
    const response = await ctx.request('GET', '/api/fraud/flags');
    assert.equal(response.status, 401);
  });

  it('lists flags, and the thresholds that produced them', async () => {
    await burst(3, { outcome: 'pin_failed', pinOutcome: 'wrong_pin' });

    const response = await call(await account('admin'), 'GET', '/api/fraud/flags');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.flags.length, 1);
    assert.equal(body.totals.highRisk, 1);
    // On screen so a reviewer can argue with the number without reading source.
    assert.ok(body.rules.some((rule) => rule.name === 'pin_velocity' && rule.threshold === 3));
  });

  it('hands over the attempts a flag counted', async () => {
    await burst(3, { outcome: 'pin_failed', pinOutcome: 'wrong_pin' });
    const token = await account('admin');

    const list = await (await call(token, 'GET', '/api/fraud/flags')).json();
    const detail = await (
      await call(token, 'GET', `/api/fraud/flags/${list.flags[0].id}`)
    ).json();

    assert.equal(detail.evidence.length, 3);
    assert.equal(detail.evidence[0].outcome, 'pin_failed');
    assert.equal(detail.evidence[0].pinOutcome, 'wrong_pin');
  });

  it('records a review once and will not let it be rewritten', async () => {
    await burst(3, { outcome: 'pin_failed' });
    const token = await account('admin');
    const list = await (await call(token, 'GET', '/api/fraud/flags')).json();
    const { id } = list.flags[0];

    const first = await call(token, 'POST', `/api/fraud/flags/${id}/confirm`, {
      note: 'card skimmer',
    });
    assert.equal(first.status, 200);

    // Re-deciding would let the record of who decided what, and when, be
    // quietly changed.
    const second = await call(token, 'POST', `/api/fraud/flags/${id}/clear`);
    assert.equal(second.status, 409);

    const after = await FraudFlag.findById(id);
    assert.equal(after.status, 'confirmed');
    assert.equal(after.reviewedBy, 'admin');
    assert.equal(after.note, 'card skimmer');
  });
});
