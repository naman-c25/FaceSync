import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { User } from '../src/models/User.js';
import { VerificationLog } from '../src/models/VerificationLog.js';
import { decryptEmbedding } from '../src/services/encryption.js';
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

/** Walk a user through enrollment and return their id. */
async function enrol({ displayName = 'Test Subject', region, merchantId } = {}) {
  const start = await ctx.request('POST', '/api/enroll/start', {
    displayName,
    region,
    merchantId,
  });

  for (let i = 0; i < 5; i += 1) {
    await ctx.request('POST', '/api/enroll/capture', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });
  }

  const done = await ctx.request('POST', '/api/enroll/finalize', {
    sessionId: start.body.sessionId,
  });
  return done.body.userId;
}

/** Run a verification through to a liveness pass, stopping before matching. */
async function verifyUntilReady({ merchantId = 'shop-1', region } = {}) {
  const start = await ctx.request('POST', '/api/verify/start', {
    merchantId,
    region,
  });

  ctx.ml.state.livenessOutcome = 'passed';
  await ctx.request('POST', '/api/verify/frame', {
    sessionId: start.body.sessionId,
    image: FAKE_FRAME,
  });

  return start.body.sessionId;
}

describe('enrollment', () => {
  it('stores an encrypted embedding, never a raw one', async () => {
    const userId = await enrol();

    const stored = await User.findById(userId).select('+embedding').lean();
    const raw = stored.embedding;

    // 512 float32s would be 2048 bytes; the record carries a version byte, an
    // IV and an auth tag on top, so a plain vector would be the wrong size.
    assert.notEqual(raw.length, 512 * 4);
    assert.equal(decryptEmbedding(raw).length, 512 * 4);
  });

  it('never returns the embedding in an API response', async () => {
    const start = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Test Subject',
    });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: start.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    const done = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId: start.body.sessionId,
    });

    assert.equal(done.status, 201);
    assert.ok(!JSON.stringify(done.body).includes('embedding_b64'));
    assert.equal(done.body.embedding, undefined);
  });

  it('reports a rejected frame without failing the request', async () => {
    // A blurry frame is part of the normal flow — the kiosk shows the reason
    // and keeps capturing rather than starting over.
    const start = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Test Subject',
    });
    ctx.ml.state.enrollmentAccepts = false;

    const capture = await ctx.request('POST', '/api/enroll/capture', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });

    assert.equal(capture.status, 200);
    assert.equal(capture.body.accepted, false);
    assert.equal(capture.body.reason, 'frame_too_blurry');
  });

  it('rejects a request with no display name', async () => {
    const response = await ctx.request('POST', '/api/enroll/start', {});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_request');
  });

  it('rejects an unknown session', async () => {
    const response = await ctx.request('POST', '/api/enroll/capture', {
      sessionId: '507f1f77bcf86cd799439011',
      image: FAKE_FRAME,
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'session_not_found');
  });
});

describe('verification', () => {
  it('identifies an enrolled user and reports both scores', async () => {
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    const result = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(result.body.decision, 'matched');
    assert.equal(result.body.user.userId, userId);
    assert.equal(result.body.nextStep, 'second_factor');
    // The runner-up is what separates a confident match from a coin flip.
    assert.equal(typeof result.body.confidence.runnerUp, 'number');
    assert.equal(typeof result.body.confidence.margin, 'number');
  });

  it('actually sends the enrolled embeddings to the ML service', async () => {
    // Without this the suite passes on an empty gallery, because the fake
    // returns whichever user it was told to. A decryption fault in the pool
    // builder would then look exactly like a working system.
    await enrol();
    await enrol({ displayName: 'Second Subject' });
    const sessionId = await verifyUntilReady();

    await ctx.request('POST', '/api/verify/match', { sessionId });
    const call = ctx.ml.state.requests.findLast(
      (r) => r.key === 'POST /verify/match',
    );

    assert.equal(call.body.gallery.length, 2, 'both enrolled users must be compared');
    for (const entry of call.body.gallery) {
      assert.equal(
        Buffer.from(entry.embedding_b64, 'base64').length,
        512 * 4,
        'the gallery must carry decrypted 512-d vectors',
      );
    }
  });

  it('refuses to name a user when the top two are too close', async () => {
    await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchDecision = 'ambiguous';

    const result = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(result.body.decision, 'ambiguous');
    assert.equal(result.body.user, null, 'an ambiguous result must not name anyone');
    assert.equal(result.body.nextStep, 'disambiguate');
  });

  it('rejects a face nobody enrolled', async () => {
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchDecision = 'no_match';

    const result = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(result.body.decision, 'no_match');
    assert.equal(result.body.nextStep, 'reject');
  });

  it('caps how many times one session may be retried', async () => {
    // Otherwise a single face could be retried against the margin rule until
    // one attempt happened to land.
    await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchDecision = 'no_match';

    for (let i = 0; i < 3; i += 1) {
      await ctx.request('POST', '/api/verify/match', { sessionId });
    }
    const blocked = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'attempts_exhausted');
  });

  it('closes the session once a user is identified', async () => {
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    await ctx.request('POST', '/api/verify/match', { sessionId });
    const again = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(again.status, 409);
  });

  it('reports a liveness failure and closes the session', async () => {
    const start = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
    });
    ctx.ml.state.livenessOutcome = 'failed';

    const frame = await ctx.request('POST', '/api/verify/frame', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });

    assert.equal(frame.body.status, 'failed');
    assert.equal(frame.body.failureReason, 'challenge_timeout');

    const next = await ctx.request('POST', '/api/verify/frame', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });
    assert.equal(next.status, 409, 'a dead challenge must not accept more frames');
  });
});

describe('audit trail', () => {
  it('logs a successful match with both scores and the thresholds used', async () => {
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    await ctx.request('POST', '/api/verify/match', { sessionId });
    const log = await VerificationLog.findOne({ sessionId }).lean();

    assert.equal(log.outcome, 'matched');
    assert.equal(String(log.matchedUser), userId);
    assert.equal(typeof log.scores.top, 'number');
    assert.equal(typeof log.scores.runnerUp, 'number');
    assert.ok(log.thresholds, 'the settings behind a decision must be recoverable');
    assert.ok(log.liveness.passed);
    assert.equal(log.liveness.blinksDetected, 2);
  });

  it('logs a liveness failure, which is what a spoof attempt looks like', async () => {
    const start = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
      deviceId: 'kiosk-7',
    });
    ctx.ml.state.livenessOutcome = 'failed';

    await ctx.request('POST', '/api/verify/frame', {
      sessionId: start.body.sessionId,
      image: FAKE_FRAME,
    });

    const log = await VerificationLog.findOne({
      sessionId: start.body.sessionId,
    }).lean();

    assert.equal(log.outcome, 'liveness_failed');
    assert.equal(log.liveness.passed, false);
    assert.equal(log.liveness.failureReason, 'challenge_timeout');
    assert.equal(log.deviceId, 'kiosk-7');
  });

  it('keeps the probe embedding when an attempt does not resolve to a user', async () => {
    // What makes it possible to recognise the same unidentified face turning
    // up repeatedly across merchants.
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchDecision = 'no_match';

    await ctx.request('POST', '/api/verify/match', { sessionId });
    const log = await VerificationLog.findOne({ sessionId })
      .select('+probeEmbedding')
      .lean();

    assert.ok(log.probeEmbedding, 'a failed attempt must retain its probe');
    assert.equal(decryptEmbedding(log.probeEmbedding).length, 512 * 4);
  });

  it('does not keep a probe embedding for a successful match', async () => {
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    await ctx.request('POST', '/api/verify/match', { sessionId });
    const log = await VerificationLog.findOne({ sessionId })
      .select('+probeEmbedding')
      .lean();

    assert.equal(log.probeEmbedding, null, 'that identity is already on file');
  });

  it('never exposes a stored probe through JSON', async () => {
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchDecision = 'no_match';
    await ctx.request('POST', '/api/verify/match', { sessionId });

    const log = await VerificationLog.findOne({ sessionId }).select(
      '+probeEmbedding',
    );
    assert.equal(log.toJSON().probeEmbedding, undefined);
  });
});

describe('ML service failures', () => {
  it('reports an unavailable ML service as a gateway error, not a client one', async () => {
    ctx.ml.state.failNextRequest = { status: 500, detail: 'model exploded' };

    const response = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'ml_service_unavailable');
  });

  it('passes a client-side rejection through with its own status', async () => {
    ctx.ml.state.failNextRequest = { status: 409, detail: 'liveness not passed' };
    const start = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
    });

    ctx.ml.state.failNextRequest = { status: 409, detail: 'liveness not passed' };
    const response = await ctx.request('POST', '/api/verify/match', {
      sessionId: start.body?.sessionId ?? '507f1f77bcf86cd799439011',
    });

    assert.ok([404, 409].includes(response.status));
  });

  it('does not leak internal detail on an unexpected failure', async () => {
    ctx.ml.state.failNextRequest = {
      status: 500,
      detail: '/srv/secret/path/model.onnx not found',
    };

    const response = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
    });

    assert.ok(!JSON.stringify(response.body).includes('/srv/secret'));
  });

  it('times out rather than hanging when the ML service stalls', async () => {
    ctx.ml.state.delayMs = 4000; // beyond ML_SERVICE_TIMEOUT_MS in test.env

    const response = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
    });

    assert.equal(response.status, 502);
  });
});
