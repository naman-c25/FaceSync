import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Merchant } from '../src/models/Merchant.js';
import { Transaction } from '../src/models/Transaction.js';
import { User } from '../src/models/User.js';
import { VerificationLog } from '../src/models/VerificationLog.js';
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

async function enrol({ displayName = 'Real Person', pin = '4827' } = {}) {
  const start = await ctx.request('POST', '/api/enroll/start', { displayName });
  for (let i = 0; i < 5; i += 1) {
    await ctx.request('POST', '/api/enroll/capture', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });
  }
  const done = await ctx.request('POST', '/api/enroll/finalize', {
    sessionId: start.body.sessionId,
    pin,
  });
  return done.body.userId;
}

const claim = (body) => ctx.request('POST', '/api/user/claim', body);

async function signedIn(overrides = {}) {
  await enrol(overrides);
  const { body } = await claim({
    displayName: overrides.displayName ?? 'Real Person',
    pin: overrides.pin ?? '4827',
    email: 'me@example.test',
    password: 'a-long-enough-password',
  });
  return body.token;
}

function authed(method, path, token, body) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

describe('claiming a portal account', () => {
  it('needs the PIN, not just the name', async () => {
    // Names are neither unique nor secret. If the name were the credential,
    // anyone who knew yours could read your payment history.
    await enrol({ displayName: 'Real Person', pin: '4827' });

    const wrong = await claim({
      displayName: 'Real Person',
      pin: '9163',
      email: 'attacker@example.test',
      password: 'a-long-enough-password',
    });

    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'claim_failed');
  });

  it('says the same thing whether the name or the PIN was wrong', async () => {
    // Otherwise this becomes a way to find out who is enrolled.
    await enrol({ displayName: 'Real Person', pin: '4827' });

    const noSuchName = await claim({
      displayName: 'Nobody At All',
      pin: '4827',
      email: 'a@example.test',
      password: 'a-long-enough-password',
    });
    const wrongPin = await claim({
      displayName: 'Real Person',
      pin: '9163',
      email: 'b@example.test',
      password: 'a-long-enough-password',
    });

    assert.equal(noSuchName.status, wrongPin.status);
    assert.equal(noSuchName.body.error.message, wrongPin.body.error.message);
  });

  it('attaches to the existing face record rather than making a second', async () => {
    // Enrolling is what creates the identity. This only adds a way to read it
    // back, and a second row would be a second face in the gallery.
    const userId = await enrol();
    const { status, body } = await claim({
      displayName: 'Real Person',
      pin: '4827',
      email: 'me@example.test',
      password: 'a-long-enough-password',
    });

    assert.equal(status, 201);
    assert.equal(body.user.userId, userId);
    assert.equal(await User.countDocuments({ source: 'live' }), 1);
  });

  it('will not take an email that is already in use', async () => {
    await signedIn();
    await enrol({ displayName: 'Someone Else', pin: '9163' });

    const { status, body } = await claim({
      displayName: 'Someone Else',
      pin: '9163',
      email: 'me@example.test',
      password: 'a-long-enough-password',
    });

    assert.equal(status, 409);
    assert.equal(body.error.code, 'email_taken');
  });

  it('leaves enrollment needing no email at all', async () => {
    // The property the whole system rests on: a face can be registered and can
    // pay without anyone handing over an identifier.
    const userId = await enrol();
    const stored = await User.findById(userId).select('+email +passwordHash').lean();

    assert.equal(stored.email, null);
    assert.equal(stored.passwordHash, null);
  });
});

describe('the portal', () => {
  it('refuses everything without a token', async () => {
    for (const [method, path] of [
      ['GET', '/api/user/me'],
      ['GET', '/api/user/transactions'],
      ['DELETE', '/api/user/me'],
    ]) {
      const response = await fetch(`${ctx.baseUrl}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  });

  it('will not accept a merchant token', async () => {
    // The two are signed with different keys derived from the same secret, so
    // one cannot be presented as the other. Checked rather than assumed.
    await Merchant.create({
      merchantId: 'shop-1',
      name: 'Corner Store',
      email: 'corner@shop.test',
      passwordHash: (await import('../src/services/merchantAuth.js')).hashPassword('hunter2hunter2'),
      role: 'merchant',
    });
    const { body } = await ctx.request('POST', '/api/merchant/login', {
      email: 'corner@shop.test',
      password: 'hunter2hunter2',
    });

    const { status } = await authed('GET', '/api/user/me', body.token);
    assert.equal(status, 401);
  });

  it('shows what is held, and never the face data itself', async () => {
    const token = await signedIn();
    const { body } = await authed('GET', '/api/user/me', token);

    assert.equal(body.displayName, 'Real Person');
    assert.equal(body.security.hasPin, true);
    assert.ok(body.dataHeld.length >= 3);

    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('embedding'));
    assert.ok(!serialised.includes('pinHash'));
    assert.ok(!serialised.includes('passwordHash'));
  });

  it('shows only this person’s own payments, with the shop named', async () => {
    const token = await signedIn();
    const mine = await User.findOne({ email: 'me@example.test' });
    const someoneElse = await enrol({ displayName: 'Someone Else', pin: '9163' });

    await Merchant.create({
      merchantId: 'shop-1',
      name: 'Corner Store',
      email: 'corner@shop.test',
      passwordHash: 'x:00',
      role: 'merchant',
    });
    await Transaction.create({
      merchantId: 'shop-1', user: mine._id, amountPaise: 2500,
      authFactors: ['face', 'pin'], status: 'authorized',
    });
    await Transaction.create({
      merchantId: 'shop-1', user: someoneElse, amountPaise: 9900,
      authFactors: ['face', 'pin'], status: 'authorized',
    });

    const { body } = await authed('GET', '/api/user/transactions', token);

    assert.equal(body.transactions.length, 1);
    assert.equal(body.transactions[0].amount, 25);
    assert.equal(body.transactions[0].merchant.name, 'Corner Store');
    assert.equal(body.summary.total, 25);
  });
});

describe('deleting your face data', () => {
  it('needs the PIN and the words typed out', async () => {
    const token = await signedIn();

    const noConfirm = await authed('DELETE', '/api/user/me', token, { pin: '4827' });
    const wrongPin = await authed('DELETE', '/api/user/me', token, {
      confirm: 'DELETE MY FACE DATA',
      pin: '9163',
    });

    assert.equal(noConfirm.status, 400);
    assert.equal(wrongPin.status, 401);
    assert.equal(await User.countDocuments({ source: 'live' }), 1);
  });

  it('removes the face record for real', async () => {
    // The consent screen promises this, so it has to be a deletion rather than
    // a flag.
    const token = await signedIn();

    const { status, body } = await authed('DELETE', '/api/user/me', token, {
      confirm: 'DELETE MY FACE DATA',
      pin: '4827',
    });

    assert.equal(status, 200);
    assert.equal(body.deleted, true);
    assert.equal(await User.countDocuments({ source: 'live' }), 0);
  });

  it('also clears the probe embeddings kept on failed attempts', async () => {
    // Those are face data too. Leaving them would make the promise false in
    // the one place nobody would think to look.
    const token = await signedIn();
    const mine = await User.findOne({ email: 'me@example.test' });

    await VerificationLog.create({
      sessionId: 'x', merchantId: 'shop-1', outcome: 'matched',
      matchedUser: mine._id, probeEmbedding: Buffer.alloc(64, 7),
    });

    await authed('DELETE', '/api/user/me', token, {
      confirm: 'DELETE MY FACE DATA',
      pin: '4827',
    });

    const log = await VerificationLog.findOne().select('+probeEmbedding').lean();
    assert.equal(log.probeEmbedding, null);
    assert.equal(log.matchedUser, null);
  });

  it('keeps the payment records but severs the link', async () => {
    // They are the shop's accounts as much as the customer's. Deleting them
    // would not be a privacy feature, it would be a hole in a ledger.
    const token = await signedIn();
    const mine = await User.findOne({ email: 'me@example.test' });

    await Transaction.create({
      merchantId: 'shop-1', user: mine._id, amountPaise: 2500,
      authFactors: ['face', 'pin'], status: 'authorized',
    });

    await authed('DELETE', '/api/user/me', token, {
      confirm: 'DELETE MY FACE DATA',
      pin: '4827',
    });

    const left = await Transaction.findOne().lean();
    assert.equal(left.amountPaise, 2500);
    assert.equal(left.user, null);
  });

  it('leaves the session useless afterwards', async () => {
    const token = await signedIn();
    await authed('DELETE', '/api/user/me', token, {
      confirm: 'DELETE MY FACE DATA',
      pin: '4827',
    });

    const { status } = await authed('GET', '/api/user/me', token);
    assert.equal(status, 404);
  });
});
