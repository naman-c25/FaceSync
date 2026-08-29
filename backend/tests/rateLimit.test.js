import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { authLimiter, globalLimiter, sessionLimiter } from '../src/middleware/rateLimit.js';
import { createTestContext } from './helpers/context.js';

/**
 * The limiters are checked here rather than against the real app, because the
 * suite runs every request from one address with limits switched off. So each
 * one is mounted on a throwaway app with small numbers, and asked the only
 * question that matters: does it actually refuse, and does it refuse the right
 * requests?
 */

/** Serve one limiter on a scratch app and return a caller for it. */
function serve(middleware, handler = (_req, res) => res.json({ ok: true })) {
  const app = express();
  app.use(express.json());
  app.post('/thing', middleware, handler);

  const server = app.listen(0);
  const port = server.address().port;

  return {
    close: () => server.close(),
    call: async (body = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/thing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

describe('the auth limiter', () => {
  it('refuses once the failures run out, in the API error shape', async () => {
    // Fails every time, so every request counts.
    const app = serve(
      authLimiter({ limit: 3, windowMs: 60_000 }),
      (_req, res) => res.status(401).json({ error: { code: 'bad', message: 'no' } }),
    );

    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await app.call()).status, 401, `attempt ${i + 1} should reach the route`);
      }

      const refused = await app.call();
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, 'too_many_attempts');
      assert.ok(refused.body.error.message, 'a refusal has to say something');
    } finally {
      app.close();
    }
  });

  it('does not spend budget on people who succeed', async () => {
    // The reason this limiter exists in the shape it does. Twenty people on
    // one shop's wifi are one address; a limiter that counted their successful
    // sign-ins would take the demo down instead of an attacker.
    const app = serve(authLimiter({ limit: 3, windowMs: 60_000 }));

    try {
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await app.call()).status, 200, `sign-in ${i + 1} should be allowed`);
      }
    } finally {
      app.close();
    }
  });

  it('still counts failures that happen between successes', async () => {
    let succeed = true;
    const app = serve(authLimiter({ limit: 2, windowMs: 60_000 }), (_req, res) => {
      if (succeed) return res.json({ ok: true });
      return res.status(401).json({ error: { code: 'bad', message: 'no' } });
    });

    try {
      assert.equal((await app.call()).status, 200);
      succeed = false;
      assert.equal((await app.call()).status, 401);
      assert.equal((await app.call()).status, 401);
      assert.equal((await app.call()).status, 429, 'the two failures should have counted');
    } finally {
      app.close();
    }
  });
});

describe('the session limiter', () => {
  it('counts every attempt, successful or not', async () => {
    // Unlike sign-in, opening a session is the cost being defended -- it
    // writes a row -- so success is not a reason to skip it.
    const app = serve(sessionLimiter({ limit: 2, windowMs: 60_000 }));

    try {
      assert.equal((await app.call()).status, 200);
      assert.equal((await app.call()).status, 200);

      const refused = await app.call();
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, 'too_many_sessions');
    } finally {
      app.close();
    }
  });
});

describe('the global limiter', () => {
  it('refuses with its own code', async () => {
    const app = serve(globalLimiter({ limit: 1, windowMs: 60_000 }));

    try {
      assert.equal((await app.call()).status, 200);
      const refused = await app.call();
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, 'too_many_requests');
    } finally {
      app.close();
    }
  });
});

describe('the shipped defaults', () => {
  it('allow a whole verification through the session limit', async () => {
    // One scan is 20-30 frames but only one session start, which is why the
    // limit sits on the start. If this ever moved onto the frames, this test
    // is what should fail.
    const app = serve(sessionLimiter());

    try {
      for (let i = 0; i < 30; i += 1) {
        assert.equal((await app.call()).status, 200, `session ${i + 1}`);
      }
    } finally {
      app.close();
    }
  });
});

let ctx;

before(async () => {
  ctx = await createTestContext();
});
after(async () => {
  await ctx.close();
});

describe('the security headers the app actually sends', () => {
  it('refuses to be framed, and pins the script source', async () => {
    // A payment button inside somebody else's iframe is a click waiting to be
    // stolen, and this process serves the page as well as the API.
    const response = await fetch(`${ctx.baseUrl}/health`);
    const csp = response.headers.get('content-security-policy');

    assert.ok(csp, 'there should be a CSP at all');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(
      csp,
      /script-src[^;]*unsafe-inline/,
      'inline script is the directive that stops injected markup running',
    );
    assert.match(csp, /object-src 'none'/);
  });

  it('allows the inline styles the landing page animates with', async () => {
    // useSmoothScroll writes scroll progress into a style attribute. Without
    // this the page loads and simply never moves, which is the kind of break
    // that looks like a broken feature rather than a policy.
    const response = await fetch(`${ctx.baseUrl}/health`);
    const csp = response.headers.get('content-security-policy');

    assert.match(csp, /style-src[^;]*'unsafe-inline'/);
  });

  it('allows the camera preview and the captured frame', async () => {
    const response = await fetch(`${ctx.baseUrl}/health`);
    const csp = response.headers.get('content-security-policy');

    assert.match(csp, /img-src[^;]*data:/, 'a captured frame is a data URL');
    assert.match(csp, /media-src[^;]*blob:/, 'the camera preview is a blob source');
  });

  it('sets the rest of the usual headers, and still hides the framework', async () => {
    const response = await fetch(`${ctx.baseUrl}/health`);

    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-powered-by'), null);

    // Must agree with `frame-ancestors 'none'`, or the weaker of the two is
    // what an older browser acts on.
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  });
});
