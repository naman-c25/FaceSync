import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import * as gallerySync from '../src/services/gallerySync.js';
import { createTestContext, FAKE_FRAME } from './helpers/context.js';

/**
 * The gallery lives in the ML service now, and a scan sends ids.
 *
 * What is worth testing is not the speed -- it is every way the two copies can
 * disagree, because a gallery missing the person standing at the till answers
 * `no_match`, which is indistinguishable from a stranger. Each test below is
 * one way that could happen.
 */

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

async function enrol(displayName = 'Real Person', pin = '4827') {
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

/** Run a kiosk scan through liveness and return the session id. */
async function scanUntilReady() {
  const start = await ctx.request('POST', '/api/verify/start', { deviceId: 'kiosk-1' });
  ctx.ml.state.livenessOutcome = 'passed';
  await ctx.request('POST', '/api/verify/frame', {
    sessionId: start.body.sessionId,
    frames: [{ image: FAKE_FRAME, capturedAtMs: 0 }],
  });
  return start.body.sessionId;
}

const pushes = () => ctx.ml.state.requests.filter((r) => r.key === 'POST /gallery/load');
const matches = () => ctx.ml.state.requests.filter((r) => r.key === 'POST /verify/match');

describe('the gallery is pushed once, not shipped per scan', () => {
  it('sends ids on the match, not embeddings', async () => {
    await enrol();
    const sessionId = await scanUntilReady();
    await ctx.request('POST', '/api/verify/match', { sessionId });

    const call = matches().at(-1);
    assert.ok(call.body.candidate_ids, 'the match should name ids');
    assert.ok(call.body.gallery_id, 'and quote the gallery they belong to');
    assert.equal(
      call.body.gallery?.length ?? 0,
      0,
      'the vectors must not travel with every scan -- that is the whole point',
    );
  });

  it('does not re-push when nothing has changed', async () => {
    // The saving only exists if a second scan is free. If this ever starts
    // pushing per scan, the change has quietly undone itself.
    await enrol();

    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });
    const afterFirst = pushes().length;

    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });
    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });

    assert.equal(pushes().length, afterFirst, 'the gallery was pushed again for nothing');
    assert.equal(matches().length, 3, 'all three scans should still have run');
  });

  it('re-pushes when somebody new enrols', async () => {
    // The case that would otherwise leave a customer unrecognised moments
    // after registering: their id is not in what was pushed.
    await enrol('First Person');
    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });
    const before = pushes().length;

    await enrol('Second Person', '5162');
    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });

    assert.ok(pushes().length > before, 'the new face was never pushed');
    assert.equal(
      pushes().at(-1).body.entries.length,
      2,
      'both people should be in the pushed gallery',
    );
  });

  it('re-pushes after a deletion, so a removed face cannot still match', async () => {
    // The endpoint promises the face is gone. Leaving it resident in another
    // process would make that promise false.
    const enrolled = await enrol();
    await ctx.request('POST', '/api/user/claim', {
      displayName: 'Real Person',
      pin: '4827',
      email: 'gone@person.test',
      password: 'a-long-enough-one',
    });
    const { body: signedIn } = await ctx.request('POST', '/api/user/login', {
      email: 'gone@person.test',
      password: 'a-long-enough-one',
    });

    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });
    const before = pushes().length;

    await fetch(`${ctx.baseUrl}/api/user/me`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signedIn.token}`,
      },
      body: JSON.stringify({ pin: '4827', confirm: 'DELETE MY FACE DATA' }),
    });

    assert.equal(gallerySync.stats().galleryId, null, 'the deletion must invalidate');

    await enrol('Someone Else', '9163');
    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });

    assert.ok(pushes().length > before);
    const ids = pushes().at(-1).body.entries.map((e) => e.user_id);
    assert.ok(
      !ids.includes(String(enrolled.body.userId)),
      'the deleted face is still in the pushed gallery',
    );
  });
});

describe('when the two copies disagree', () => {
  it('re-pushes and retries when the ML service has forgotten', async () => {
    // What a Python restart looks like: this process still believes its push
    // landed. The refusal comes back as 409 and the scan has to survive it.
    await enrol();
    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });

    ctx.ml.state.loadedGalleryId = null;
    ctx.ml.state.loadedEntries = [];

    const sessionId = await scanUntilReady();
    const { status, body } = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(status, 200, 'a forgotten gallery must not fail the scan');
    assert.equal(body.decision, 'matched');
    assert.equal(
      ctx.ml.state.loadedEntries.length,
      1,
      'the gallery should have been pushed again',
    );
  });

  it('falls back to shipping the pool when the push will not land', async () => {
    // The reason this was safe to add at all: a sync problem costs speed, not
    // service. The old path is still there and still correct.
    await enrol();
    ctx.ml.state.failNextGalleryLoad = true;

    const sessionId = await scanUntilReady();
    const { status, body } = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(status, 200);
    assert.equal(body.decision, 'matched');

    const call = matches().at(-1);
    assert.equal(call.body.gallery.length, 1, 'the pool should have travelled inline');
    assert.equal(call.body.gallery_id ?? null, null);
  });
});

describe('warming at boot', () => {
  it('pushes the gallery before anyone scans', async () => {
    // Otherwise the first customer after a restart pays for the whole build --
    // about 30 seconds at ten thousand signatures, which is past the ML
    // timeout, so they do not wait, they fail.
    await enrol();
    gallerySync.invalidate();
    ctx.ml.state.requests.length = 0;

    const { buildCandidatePool } = await import('../src/services/candidatePool.js');
    await gallerySync.warm(() => buildCandidatePool({ narrow: false }));

    assert.equal(pushes().length, 1, 'boot should push exactly once');
    assert.equal(gallerySync.stats().synced, 1);

    // And the first real scan then costs nothing extra.
    await ctx.request('POST', '/api/verify/match', { sessionId: await scanUntilReady() });
    assert.equal(pushes().length, 1, 'the first scan re-pushed a warm gallery');
  });

  it('does not throw when the ML service is unreachable', async () => {
    // A service that will not start because it could not pre-warm a cache is
    // worse than a slow first scan.
    await enrol();
    gallerySync.invalidate();
    ctx.ml.state.failNextGalleryLoad = true;

    const { buildCandidatePool } = await import('../src/services/candidatePool.js');
    await gallerySync.warm(() => buildCandidatePool({ narrow: false }));

    assert.equal(gallerySync.stats().galleryId, null);
  });

  it('says nothing to warm when nobody is enrolled', async () => {
    const { buildCandidatePool } = await import('../src/services/candidatePool.js');
    await gallerySync.warm(() => buildCandidatePool({ narrow: false }));
    assert.equal(pushes().length, 0);
  });
});
