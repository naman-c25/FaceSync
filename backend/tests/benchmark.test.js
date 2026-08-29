import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Merchant } from '../src/models/Merchant.js';
import { Transaction } from '../src/models/Transaction.js';
import { User } from '../src/models/User.js';
import { encryptEmbedding } from '../src/services/encryption.js';
import { hashPassword } from '../src/services/merchantAuth.js';
import { hashPin } from '../src/services/pin.js';
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
});

/** A plausible 512-d unit vector, so stored rows look like real ones. */
function embedding(seed = 1) {
  const buffer = Buffer.alloc(512 * 4);
  let norm = 0;
  const values = Array.from({ length: 512 }, (_, i) => {
    const v = Math.sin(seed * (i + 1));
    norm += v * v;
    return v;
  });
  norm = Math.sqrt(norm);
  values.forEach((v, i) => buffer.writeFloatLE(v / norm, i * 4));
  return encryptEmbedding(buffer);
}

async function addBenchmarkRow(label = 'George_W_Bush') {
  return User.create({
    displayName: label.replaceAll('_', ' '),
    embedding: embedding(2),
    source: 'benchmark',
    benchmarkLabel: label,
    enrollment: { samplesUsed: 1, meanSimilarity: 1 },
    lastSeenAt: new Date(),
  });
}

async function enrol({ displayName = 'Real Person', pin = '4827' } = {}) {
  const start = await ctx.request('POST', '/api/enroll/start', { displayName });
  for (let i = 0; i < 5; i += 1) {
    await ctx.request('POST', '/api/enroll/capture', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });
  }
  return ctx.request('POST', '/api/enroll/finalize', {
    sessionId: start.body.sessionId,
    pin,
  });
}

async function signInMerchant() {
  await Merchant.create({
    merchantId: 'shop-1',
    name: 'Corner Store',
    email: 'corner@shop.test',
    passwordHash: hashPassword('hunter2hunter2'),
    role: 'merchant',
  });

  const { body } = await ctx.request('POST', '/api/merchant/login', {
    email: 'corner@shop.test',
    password: 'hunter2hunter2',
  });
  return body.token;
}

/** Run a scan through liveness and stop, ready to be charged. */
async function scan(token) {
  // The shop comes from the token now -- there is no longer a way to name one
  // in the body, which is what let an unapproved terminal borrow somebody
  // else's id.
  const start = await fetch(`${ctx.baseUrl}/api/merchant/verify/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ deviceId: 'till' }),
  }).then((r) => r.json());

  ctx.ml.state.livenessOutcome = 'passed';
  await ctx.request('POST', '/api/verify/frame', {
    sessionId: start.sessionId,
    frames: [{ image: FAKE_FRAME, capturedAtMs: 0 }],
  });

  return start.sessionId;
}

async function charge(token, sessionId, body) {
  const response = await fetch(`${ctx.baseUrl}/api/merchant/charge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionId, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

describe('benchmark rows in the gallery', () => {
  it('are compared against, which is the entire point of loading them', async () => {
    // If they were excluded from the pool they would measure nothing. The
    // gallery has to be genuinely bigger for the scale measurement to mean
    // anything.
    const live = await enrol();
    await addBenchmarkRow();

    const token = await signInMerchant();
    const sessionId = await scan(token);

    // The gallery is only assembled when the match is actually run, which is
    // inside the charge — liveness alone never asks the ML service who this is.
    ctx.ml.state.matchUserId = live.body.userId;
    await charge(token, sessionId, { amount: 250, pin: '4827' });

    const matchCall = ctx.ml.state.requests.findLast(
      (r) => r.key === 'POST /verify/match',
    );
    assert.ok(matchCall, 'no match request reached the ML service');
    assert.equal(
      matchCall.body.gallery.length,
      2,
      'the benchmark row was not in the candidate pool',
    );
  });

  it('cannot be charged', async () => {
    // Reaching this means a live face out-scored every real customer against a
    // research photograph. That is a false match, and the only correct answer
    // is to take no money and say so loudly.
    await enrol();
    const benchmarkUser = await addBenchmarkRow();

    const token = await signInMerchant();
    const sessionId = await scan(token);

    ctx.ml.state.matchDecision = 'matched';
    ctx.ml.state.matchUserId = String(benchmarkUser._id);

    const { status, body } = await charge(token, sessionId, { amount: 250 });

    assert.equal(status, 200);
    assert.equal(body.charged, false);
    assert.equal(body.decision, 'benchmark_match');
    assert.equal(await Transaction.countDocuments(), 0);

    // The refusal must not name the research subject back to the merchant.
    assert.ok(
      !JSON.stringify(body).includes('George'),
      'the benchmark subject was named in the response',
    );
  });

  it('are refused before the PIN step, not by falling through it', async () => {
    // A benchmark row has no PIN, so this would fail one step later anyway —
    // and be recorded as "this customer has not set a PIN", filing the single
    // most interesting event in the system under a routine one.
    await enrol();
    const benchmarkUser = await addBenchmarkRow();

    const token = await signInMerchant();
    const sessionId = await scan(token);

    ctx.ml.state.matchUserId = String(benchmarkUser._id);
    const { body } = await charge(token, sessionId, { amount: 250 });

    assert.notEqual(body.pinOutcome, 'no_pin_set');
    assert.equal(body.decision, 'benchmark_match');
  });

  it('never absorb a real registration', async () => {
    // The worst outcome available: a live person's face written onto a research
    // record, after which every payment they make is refused as a benchmark
    // match and they can never be enrolled properly again.
    const benchmarkUser = await addBenchmarkRow();

    // High enough that the duplicate check would collapse into it if it were
    // allowed to consider a benchmark row at all.
    ctx.ml.state.duplicateScore = 0.94;

    const { body } = await enrol({ displayName: 'Real Person' });

    assert.equal(body.updatedExisting, false, 'merged into a benchmark row');
    assert.equal(body.displayName, 'Real Person');
    assert.notEqual(body.userId, String(benchmarkUser._id));

    const untouched = await User.findById(benchmarkUser._id);
    assert.equal(untouched.displayName, 'George W Bush');
    assert.equal(untouched.source, 'benchmark');

    assert.equal(await User.countDocuments({ source: 'live' }), 1);
  });

  it('do not hide a genuine duplicate ranked below them', async () => {
    // The guard skips benchmark rows rather than giving up at the first one.
    // Taking only the top candidate would mean a benchmark row scoring highest
    // hides a real repeat registration behind it — and a second copy of a live
    // face is what locks that person out of the system for good.
    const first = await enrol({ displayName: 'Real Person' });
    await addBenchmarkRow();

    // The fake service scores gallery[0] at duplicateScore and the rest at 0.1,
    // so put the benchmark row first by making it the most recently seen.
    await User.updateOne(
      { source: 'benchmark' },
      { $set: { lastSeenAt: new Date(Date.now() + 1000) } },
    );

    ctx.ml.state.duplicateScore = 0.94;
    ctx.ml.state.compareRunnerUp = 0.9;

    const again = await enrol({ displayName: 'Real Person Again' });

    assert.equal(again.body.updatedExisting, true, 'the real duplicate was missed');
    assert.equal(again.body.userId, first.body.userId);
    assert.equal(await User.countDocuments({ source: 'live' }), 1);
  });
});

describe('benchmark rows and PINs', () => {
  it('are stored without one', async () => {
    const row = await addBenchmarkRow();
    const stored = await User.findById(row._id).select('+pinHash');
    assert.equal(stored.pinHash, null);
  });

  it('do not accept a PIN that happens to be right for someone else', async () => {
    // A benchmark row with a PIN copied from a real user would be chargeable.
    // There is no code path that sets one, and this is here so that adding one
    // breaks a test rather than a customer.
    await User.updateOne(
      { _id: (await addBenchmarkRow())._id },
      { $set: { pinHash: hashPin('4827') } },
    );

    await enrol();
    const token = await signInMerchant();
    const sessionId = await scan(token);

    const benchmarkUser = await User.findOne({ source: 'benchmark' });
    ctx.ml.state.matchUserId = String(benchmarkUser._id);

    const { body } = await charge(token, sessionId, { amount: 250, pin: '4827' });

    assert.equal(body.charged, false);
    assert.equal(body.decision, 'benchmark_match');
    assert.equal(await Transaction.countDocuments(), 0);
  });
});
