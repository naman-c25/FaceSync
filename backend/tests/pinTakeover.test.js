import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { User } from '../src/models/User.js';
import { verifyPin } from '../src/services/pin.js';
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

/** Register a face and return the finalize body. */
async function enrol(displayName, pin) {
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
  return done.body;
}

/** Present the same face again, offering `pin`. */
async function enrolAgain(displayName, pin) {
  ctx.ml.state.duplicateScore = 0.93;
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

// Both are `select: false` on the schema, and these tests check that neither
// moved.
const record = (id) => User.findById(id).select('+pinHash +embedding');

/** Put a record back into the state everything registered before sealing is in. */
const unseal = (id) => User.updateOne({ _id: id }, { $set: { pinSealed: false } });

describe('a face on its own cannot take away the PIN', () => {
  it('refuses to re-enrol a sealed record without its PIN', async () => {
    // The whole point of the PIN is that a face is only the first of two
    // things. Letting a face reset it would make the face enough to remove the
    // second -- present somebody, choose a new PIN, and what protected them is
    // gone. The refusal covers the entire enrollment, not only the PIN, so a
    // stranger cannot even rewrite the stored signature.
    const first = await enrol('Sealed Person', '4827');
    assert.equal((await record(first.userId)).pinSealed, true);

    const before = await record(first.userId);
    const again = await enrolAgain('Sealed Person', '9163');

    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, 'pin_required_to_reenrol');

    const after = await record(first.userId);
    assert.equal(after.pinHash, before.pinHash, 'the PIN must not have moved');
    assert.ok(after.embedding.equals(before.embedding), 'nor the signature');
  });

  it('lets the owner re-enrol by giving the PIN they already set', async () => {
    // Registering again is how somebody improves a poor enrollment, and that
    // has to keep working for the person it belongs to.
    const first = await enrol('Sealed Person', '4827');
    const before = await record(first.userId);

    const again = await enrolAgain('Sealed Person', '4827');
    assert.equal(again.status, 201);

    const after = await record(first.userId);
    assert.ok(
      !after.embedding.equals(before.embedding),
      'the signature should have been refreshed',
    );
    assert.ok(verifyPin('4827', after.pinHash));
    assert.equal(await User.countDocuments(), 1, 'no second copy');
  });
});

describe('records made before sealing get exactly one more chance', () => {
  it('accepts a new PIN once, and seals on the way out', async () => {
    // Everything registered while re-enrolling was the way to set a PIN is in
    // this state. Each gets one more pass so those people can carry on, and
    // the route closes behind them.
    const first = await enrol('Older Person', '4827');
    await unseal(first.userId);

    const again = await enrolAgain('Older Person', '9163');
    assert.equal(again.status, 201);

    const after = await record(first.userId);
    assert.ok(verifyPin('9163', after.pinHash), 'the new PIN should be live');
    assert.ok(!verifyPin('4827', after.pinHash), 'the old one should be gone');
    assert.equal(after.pinSealed, true, 'and the chance should be spent');
  });

  it('refuses the second attempt', async () => {
    const first = await enrol('Older Person', '4827');
    await unseal(first.userId);

    await enrolAgain('Older Person', '9163');
    const third = await enrolAgain('Older Person', '5150');

    assert.equal(third.status, 403);
    assert.ok(verifyPin('9163', (await record(first.userId)).pinHash));
  });

  it('clears a lockout on the way through', async () => {
    // Otherwise the one route out of a lockout would leave the person still
    // locked, which is the same dead end in a different costume.
    const first = await enrol('Locked Person', '4827');
    await User.updateOne(
      { _id: first.userId },
      {
        $set: {
          pinSealed: false,
          pinFailures: 3,
          pinLockedUntil: new Date(Date.now() + 900000),
        },
      },
    );

    await enrolAgain('Locked Person', '9163');

    const after = await record(first.userId);
    assert.equal(after.pinFailures, 0);
    assert.equal(after.pinLockedUntil, null);
  });
});
