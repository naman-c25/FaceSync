import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { User } from '../src/models/User.js';
import { VerificationLog } from '../src/models/VerificationLog.js';
import { decryptEmbedding } from '../src/services/encryption.js';
import { createTestContext, FAKE_FRAME } from './helpers/context.js';

/** One request's worth of frames, timed like a real 15fps capture. */
const batch = (count = 1, startMs = 0) =>
  Array.from({ length: count }, (_, i) => ({
    image: FAKE_FRAME,
    capturedAtMs: startMs + i * 66,
  }));

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
    pin: '4827',
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
    frames: batch(),
  });

  return start.body.sessionId;
}

describe('health', () => {
  it('reports degraded when the ML service has no models loaded', async () => {
    // The failure this exists for: a container missing a native library starts
    // fine and answers this endpoint while every liveness check fails. A 200
    // through that tells the platform to keep routing traffic to it.
    ctx.ml.state.modelsLoaded = false;

    const response = await ctx.request('GET', '/health');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'degraded');
    assert.equal(response.body.mlService.models_loaded, false);
  });

  it('reports degraded when the ML service is unreachable', async () => {
    ctx.ml.state.failNextRequest = { status: 500, detail: 'down' };

    const response = await ctx.request('GET', '/health');
    assert.equal(response.status, 503);
  });
});

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
      pin: '4827',
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

  it('accepts explicit nulls for the fields that are optional', async () => {
    // What a client sends when it has nothing for a field. Rejecting it made
    // the whole webcam demo unusable, with a validation error that named no
    // field to fix.
    const response = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Test Subject',
      region: null,
      merchantId: null,
    });

    assert.equal(response.status, 201);
  });

  it('names the offending field when validation fails', async () => {
    // "Request body failed validation" on its own is not actionable.
    const response = await ctx.request('POST', '/api/enroll/start', {
      displayName: '',
    });

    assert.equal(response.status, 400);
    assert.ok(response.body.error.issues.length > 0);
    assert.equal(response.body.error.issues[0].field, 'displayName');
  });

  it('updates the existing record when the same face registers again', async () => {
    // Two entries for one person sit well inside the match margin of each
    // other, so every later attempt by them comes back ambiguous. A single
    // accidental re-enrollment would lock that person out permanently.
    const first = await enrol({ displayName: 'Same Person' });

    ctx.ml.state.duplicateScore = 0.91;
    const second = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Same Person Again',
    });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: second.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    const done = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId: second.body.sessionId,
      pin: '4827',
    });

    assert.equal(done.body.userId, first, 'must reuse the existing record');
    assert.equal(done.body.updatedExisting, true);
    assert.equal(await User.countDocuments(), 1, 'no second copy may be created');
  });

  it('will not let a returning face rename the record it matched', async () => {
    // Overwriting would mean anyone able to present your face could silently
    // relabel your account, and it would hide the case worth seeing.
    await enrol({ displayName: 'Original Name' });

    ctx.ml.state.duplicateScore = 0.94;
    const again = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Different Name',
    });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: again.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    const done = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId: again.body.sessionId,
      pin: '4827',
    });

    assert.equal(done.body.displayName, 'Original Name');
    assert.equal(done.body.nameDiffers, true, 'the kiosk has to be able to say so');
    assert.equal(done.body.nameGiven, 'Different Name');

    const stored = await User.findById(done.body.userId).lean();
    assert.equal(stored.displayName, 'Original Name');
  });

  it('refreshes the stored face data when someone registers again', async () => {
    // The useful half of re-registering: a better capture replaces the old one.
    const userId = await enrol({ displayName: 'Returning' });
    const before = await User.findById(userId).select('+embedding').lean();

    ctx.ml.state.duplicateScore = 0.9;
    const again = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Returning',
    });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: again.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    await ctx.request('POST', '/api/enroll/finalize', {
      sessionId: again.body.sessionId,
      pin: '4827',
    });

    const after = await User.findById(userId).select('+embedding').lean();
    // A fresh IV per encryption means the ciphertext differs even for
    // identical input, so this only proves it was rewritten — which is the
    // claim being made.
    assert.notDeepEqual(after.embedding, before.embedding);
    assert.ok(after.enrollment.completedAt > before.enrollment.completedAt);
  });

  it('does not flag a name difference when the name is the same', async () => {
    await enrol({ displayName: 'Same Name' });

    ctx.ml.state.duplicateScore = 0.92;
    const again = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Same Name',
    });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: again.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    const done = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId: again.body.sessionId,
      pin: '4827',
    });

    assert.equal(done.body.updatedExisting, true);
    assert.equal(done.body.nameDiffers, false);
  });

  it('creates a separate record for a face nobody has registered', async () => {
    await enrol({ displayName: 'First Person' });

    ctx.ml.state.duplicateScore = 0.08;
    const second = await enrol({ displayName: 'Second Person' });

    assert.equal(await User.countDocuments(), 2);
    assert.ok(second);
  });

  it('collapses a duplicate even when the gallery is already ambiguous', async () => {
    // The check reads the top score, not the decision. Once someone has been
    // enrolled twice, `identify` returns `ambiguous` — so reading the decision
    // would let the very case that most needs collapsing slip through.
    await enrol({ displayName: 'Person' });

    ctx.ml.state.duplicateScore = 0.93;
    ctx.ml.state.matchDecision = 'ambiguous';

    const again = await ctx.request('POST', '/api/enroll/start', {
      displayName: 'Person',
    });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: again.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    await ctx.request('POST', '/api/enroll/finalize', {
      sessionId: again.body.sessionId,
      pin: '4827',
    });

    assert.equal(await User.countDocuments(), 1);
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

    // The vectors reach the ML service through the gallery push now, and the
    // match names the ids it wants compared. Both halves are checked, because
    // either one alone would pass on a gallery that never arrived.
    const push = ctx.ml.state.requests.findLast((r) => r.key === 'POST /gallery/load');
    const call = ctx.ml.state.requests.findLast((r) => r.key === 'POST /verify/match');

    assert.ok(push, 'the gallery must have been pushed');
    assert.equal(push.body.entries.length, 2, 'both enrolled users must be pushed');
    for (const entry of push.body.entries) {
      assert.equal(
        Buffer.from(entry.embedding_b64, 'base64').length,
        512 * 4,
        'the gallery must carry decrypted 512-d vectors',
      );
    }

    assert.equal(
      call.body.candidate_ids.length,
      2,
      'both enrolled users must be compared',
    );
    assert.equal(
      call.body.gallery_id,
      push.body.gallery_id,
      'the match must reference the gallery that was pushed',
    );
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

  it('holds the session open after a match, for the second factor', async () => {
    // A match is one factor. Closing here would leave the kiosk single-factor
    // while the till is two, and the same person held to different standards
    // depending on which screen they happened to be in front of.
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    const matched = await ctx.request('POST', '/api/verify/match', { sessionId });

    assert.equal(matched.body.nextStep, 'second_factor');
    assert.equal(matched.body.user.userId, userId);

    const confirmed = await ctx.request('POST', '/api/verify/confirm', {
      sessionId,
      pin: '4827',
    });
    assert.equal(confirmed.body.confirmed, true);
  });

  it('closes the session once the PIN is accepted', async () => {
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    await ctx.request('POST', '/api/verify/match', { sessionId });
    await ctx.request('POST', '/api/verify/confirm', { sessionId, pin: '4827' });

    const again = await ctx.request('POST', '/api/verify/confirm', {
      sessionId,
      pin: '4827',
    });
    assert.equal(again.status, 409);
  });

  it('refuses a wrong PIN but lets the scan stand', async () => {
    // Otherwise one mistyped digit costs another scan, which is the kind of
    // friction that makes people give up at a counter.
    const userId = await enrol();
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchUserId = userId;

    await ctx.request('POST', '/api/verify/match', { sessionId });
    const wrong = await ctx.request('POST', '/api/verify/confirm', {
      sessionId,
      pin: '4828',
    });

    assert.equal(wrong.status, 200);
    assert.equal(wrong.body.confirmed, false);
    assert.equal(wrong.body.pinOutcome, 'wrong_pin');
    assert.equal(wrong.body.attemptsLeft, 2);

    const right = await ctx.request('POST', '/api/verify/confirm', {
      sessionId,
      pin: '4827',
    });
    assert.equal(right.body.confirmed, true);
  });

  it('will not confirm a scan that never identified anyone', async () => {
    const sessionId = await verifyUntilReady();
    ctx.ml.state.matchDecision = 'no_match';
    await ctx.request('POST', '/api/verify/match', { sessionId });

    const response = await ctx.request('POST', '/api/verify/confirm', {
      sessionId,
      pin: '4827',
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'not_identified');
  });

  it('locks an identity out of the kiosk on the same terms as the till', async () => {
    // The lockout is what actually protects four digits, and it must not
    // depend on which screen the guessing happens at.
    const userId = await enrol();
    ctx.ml.state.matchUserId = userId;

    for (let i = 0; i < 3; i += 1) {
      const sessionId = await verifyUntilReady();
      await ctx.request('POST', '/api/verify/match', { sessionId });
      await ctx.request('POST', '/api/verify/confirm', { sessionId, pin: '1111' });
    }

    const sessionId = await verifyUntilReady();
    await ctx.request('POST', '/api/verify/match', { sessionId });
    const locked = await ctx.request('POST', '/api/verify/confirm', {
      sessionId,
      pin: '4827',
    });

    assert.equal(locked.body.confirmed, false);
    assert.equal(locked.body.pinOutcome, 'locked');
  });

  it('accepts explicit nulls for optional verification fields', async () => {
    const response = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
      deviceId: null,
      region: null,
    });

    assert.equal(response.status, 201);
  });

  it('reports a liveness failure and closes the session', async () => {
    const start = await ctx.request('POST', '/api/verify/start', {
      merchantId: 'shop-1',
    });
    ctx.ml.state.livenessOutcome = 'failed';

    const frame = await ctx.request('POST', '/api/verify/frame', {
      sessionId: start.body.sessionId,
      frames: batch(),
    });

    assert.equal(frame.body.status, 'failed');
    assert.equal(frame.body.failureReason, 'challenge_timeout');

    const next = await ctx.request('POST', '/api/verify/frame', {
      sessionId: start.body.sessionId,
      frames: batch(),
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
      frames: batch(),
    });

    const log = await VerificationLog.findOne({
      sessionId: start.body.sessionId,
    }).lean();

    assert.equal(log.outcome, 'liveness_failed');
    assert.equal(log.liveness.passed, false);
    assert.equal(log.liveness.failureReason, 'challenge_timeout');
    assert.equal(log.deviceId, 'kiosk-7');
  });

  it('a failed liveness check costs nothing downstream', async () => {
    // The point of running liveness first is that a spoof attempt never
    // reaches recognition. Recognition is the expensive half -- it builds the
    // candidate gallery, which is a database read and a decrypt per enrolled
    // user -- so a scan that dies at liveness must not pay for any of it.
    //
    // Enforced on the server rather than trusted to the client. The kiosk does
    // stop on its own, but "the browser knows better than to ask" is not a
    // guarantee; a replayed session id would be.
    const start = await ctx.request('POST', '/api/verify/start', {
      deviceId: 'kiosk-7',
    });
    ctx.ml.state.livenessOutcome = 'failed';

    await ctx.request('POST', '/api/verify/frame', {
      sessionId: start.body.sessionId,
      frames: batch(),
    });

    const before = ctx.ml.state.requests.length;
    const match = await ctx.request('POST', '/api/verify/match', {
      sessionId: start.body.sessionId,
    });

    assert.equal(match.status, 409);
    assert.equal(match.body.error.code, 'session_completed');

    // Nothing reached the ML service, which means no gallery was built for it.
    assert.equal(
      ctx.ml.state.requests.length,
      before,
      'a refused match must not call the ML service',
    );
    assert.equal(
      await VerificationLog.countDocuments({ sessionId: start.body.sessionId }),
      1,
      'the liveness failure is the only row this scan writes',
    );
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

describe('a PIN is required to register', () => {
  /** Enrollment up to the point of finalising, so each test can vary that call. */
  async function readyToFinalize(displayName = 'Test Subject') {
    const start = await ctx.request('POST', '/api/enroll/start', { displayName });
    for (let i = 0; i < 5; i += 1) {
      await ctx.request('POST', '/api/enroll/capture', {
        sessionId: start.body.sessionId,
        image: FAKE_FRAME,
      });
    }
    return start.body.sessionId;
  }

  it('refuses to finish without one', async () => {
    // It used to be optional, which left people registered and unable to pay --
    // a state with nothing to recommend it in a payment system, and one the
    // customer only finds out about at a till with a queue behind them.
    const sessionId = await readyToFinalize();
    const { status, body } = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId,
    });

    assert.equal(status, 400);
    assert.equal(await User.countDocuments(), 0, 'a half-finished user was stored');
    assert.ok(body.error);
  });

  it('refuses one of the PINs an attacker tries first', async () => {
    const sessionId = await readyToFinalize();
    const { status, body } = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId,
      pin: '1234',
    });

    assert.equal(status, 400);
    assert.equal(body.error.code, 'weak_pin');
    // Checked before anything is written, so a rejected PIN does not leave a
    // registration behind that the person cannot use and cannot see.
    assert.equal(await User.countDocuments(), 0);
  });

  it('refuses anything that is not four digits', async () => {
    for (const pin of ['123', '12345', '12a4']) {
      const sessionId = await readyToFinalize();
      const { status } = await ctx.request('POST', '/api/enroll/finalize', {
        sessionId,
        pin,
      });
      assert.equal(status, 400, `${pin} was accepted`);
    }
  });

  it('stores it hashed, never readable', async () => {
    const sessionId = await readyToFinalize();
    const { status, body } = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId,
      pin: '4827',
    });

    assert.equal(status, 201);
    assert.equal(body.hasPin, true);

    const stored = await User.findById(body.userId).select('+pinHash').lean();
    assert.ok(stored.pinHash);
    assert.ok(!stored.pinHash.includes('4827'));
    // And it must not travel back out in the response either.
    assert.ok(!JSON.stringify(body).includes('4827'));
  });

  it('gives a returning face the PIN it never had', async () => {
    // The way back for everyone who enrolled while it was optional: register
    // again, and the existing record is updated rather than duplicated.
    //
    // `pinSealed: false` is what those records look like -- they predate
    // sealing, so each has one remaining use of this route before it closes.
    const first = await enrol({ displayName: 'Returning' });
    await User.updateOne(
      { _id: first },
      { $set: { pinHash: null, pinSealed: false } },
    );

    ctx.ml.state.duplicateScore = 0.91;
    const sessionId = await readyToFinalize('Returning');
    const { body } = await ctx.request('POST', '/api/enroll/finalize', {
      sessionId,
      pin: '5074',
    });

    assert.equal(body.updatedExisting, true);
    assert.equal(body.userId, first, 'a second record was created');
    assert.equal(body.hasPin, true);

    const stored = await User.findById(first).select('+pinHash').lean();
    assert.ok(stored.pinHash, 'the returning face still has no PIN');
    assert.equal(stored.pinSealed, true, 'and the route should now be closed');
    assert.equal(await User.countDocuments(), 1);
  });

  it('clears a lockout when a returning face sets a new PIN', async () => {
    // Otherwise the one route out of a lockout would leave the person still
    // locked, which is the same dead end in a different costume.
    const first = await enrol({ displayName: 'Locked Out' });
    await User.updateOne(
      { _id: first },
      {
        $set: {
          pinFailures: 3,
          pinLockedUntil: new Date(Date.now() + 900000),
          pinSealed: false,
        },
      },
    );

    ctx.ml.state.duplicateScore = 0.91;
    const sessionId = await readyToFinalize('Locked Out');
    await ctx.request('POST', '/api/enroll/finalize', { sessionId, pin: '9163' });

    const stored = await User.findById(first).lean();
    assert.equal(stored.pinFailures, 0);
    assert.equal(stored.pinLockedUntil, null);
  });
});
