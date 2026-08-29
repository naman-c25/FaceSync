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

const NAME = 'Forgetful Person';
const EMAIL = 'forgetful@person.test';
const PASSWORD = 'a-long-enough-one';

/** Register a face and attach an account to it. */
async function account(pin = '4827') {
  const start = await ctx.request('POST', '/api/enroll/start', {
    displayName: NAME,
  });
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

  await ctx.request('POST', '/api/user/claim', {
    displayName: NAME,
    pin,
    email: EMAIL,
    password: PASSWORD,
  });

  return done.body.userId;
}

const signIn = (password) =>
  ctx.request('POST', '/api/user/login', { email: EMAIL, password });

const authed = (token, method, path, body) =>
  fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

describe('forgetting the password', () => {
  it('lets the name and PIN set a new one, and signs you in', async () => {
    // Nothing here sends mail, so a reset link is not available. The PIN is the
    // proof the system already holds, and it is checked through the lockout
    // that guards it everywhere else.
    await account();

    const reset = await ctx.request('POST', '/api/user/password/reset', {
      email: EMAIL,
      displayName: NAME,
      pin: '4827',
      newPassword: 'a-different-long-one',
    });

    assert.equal(reset.status, 200);
    assert.ok(reset.body.token, 'should be signed in straight away');

    assert.equal((await signIn('a-different-long-one')).status, 200);
    assert.equal((await signIn(PASSWORD)).status, 401, 'the old one should be dead');
  });

  it('answers the same way whether the email, the name or the PIN is wrong', async () => {
    // Otherwise this becomes a way to find out which addresses are registered,
    // and then to test names against them.
    await account();

    const wrongEmail = await ctx.request('POST', '/api/user/password/reset', {
      email: 'nobody@here.test',
      displayName: NAME,
      pin: '4827',
      newPassword: 'a-different-long-one',
    });
    const wrongName = await ctx.request('POST', '/api/user/password/reset', {
      email: EMAIL,
      displayName: 'Someone Else',
      pin: '4827',
      newPassword: 'a-different-long-one',
    });
    const wrongPin = await ctx.request('POST', '/api/user/password/reset', {
      email: EMAIL,
      displayName: NAME,
      pin: '9163',
      newPassword: 'a-different-long-one',
    });

    for (const response of [wrongEmail, wrongName, wrongPin]) {
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'reset_failed');
    }
  });

  it('locks after repeated wrong PINs', async () => {
    // Four digits are only safe because they run out. Without the shared
    // lockout this route would be a way around it.
    await account();

    const attempt = () =>
      ctx.request('POST', '/api/user/password/reset', {
        email: EMAIL,
        displayName: NAME,
        pin: '9163',
        newPassword: 'a-different-long-one',
      });

    await attempt();
    await attempt();
    const third = await attempt();

    assert.equal(third.status, 423);
    assert.equal(third.body.error.code, 'pin_locked');

    // And the real PIN is refused too while the lock stands.
    const withRealPin = await ctx.request('POST', '/api/user/password/reset', {
      email: EMAIL,
      displayName: NAME,
      pin: '4827',
      newPassword: 'a-different-long-one',
    });
    assert.equal(withRealPin.status, 423);
  });
});

describe('forgetting the PIN', () => {
  it('lets the account password set a new one', async () => {
    // The only way back. Before this a forgotten PIN could not be changed and
    // could not be used to delete the record either, since deletion needs it.
    const userId = await account();
    const { body } = await signIn(PASSWORD);

    const changed = await authed(body.token, 'POST', '/api/user/pin', {
      currentPassword: PASSWORD,
      newPin: '5162',
    });
    assert.equal(changed.status, 200);

    const stored = await User.findById(userId).select('+pinHash');
    assert.ok(verifyPin('5162', stored.pinHash));
    assert.ok(!verifyPin('4827', stored.pinHash));
  });

  it('still takes the old PIN from somebody who remembers it', async () => {
    const userId = await account();
    const { body } = await signIn(PASSWORD);

    const changed = await authed(body.token, 'POST', '/api/user/pin', {
      currentPin: '4827',
      newPin: '5162',
    });
    assert.equal(changed.status, 200);
    assert.ok(verifyPin('5162', (await User.findById(userId).select('+pinHash')).pinHash));
  });

  it('refuses a wrong password', async () => {
    const userId = await account();
    const { body } = await signIn(PASSWORD);

    const changed = await authed(body.token, 'POST', '/api/user/pin', {
      currentPassword: 'not-the-password',
      newPin: '5162',
    });

    assert.equal(changed.status, 401);
    assert.ok(verifyPin('4827', (await User.findById(userId).select('+pinHash')).pinHash));
  });

  it('will not take a new PIN with neither proof', async () => {
    await account();
    const { body } = await signIn(PASSWORD);

    const changed = await authed(body.token, 'POST', '/api/user/pin', {
      newPin: '5162',
    });
    assert.equal(changed.status, 400);
  });
});
