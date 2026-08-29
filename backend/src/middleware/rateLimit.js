import { rateLimit } from 'express-rate-limit';

import { config } from '../config/index.js';

/**
 * Request limits, in three tiers.
 *
 * The shape matters more than the numbers. A single global limit either sits
 * high enough to be useless against password guessing, or low enough to break
 * a verification — which is 20-30 requests for one customer standing at a
 * till. So the limits are per surface, and each is set against what that
 * surface actually costs.
 *
 * Everything here is in-process memory, which is correct only because the
 * deployment runs one replica (see DEPLOY.md — liveness sessions require it).
 * A second replica needs a shared store, or each replica enforces its own
 * fraction of the limit.
 */

/** The API's error shape, so a limit reads like every other refusal. */
const refuse = (code, message) => (req, res) =>
  res.status(429).json({ error: { code, message } });

const passThrough = (_req, _res, next) => next();

/**
 * Attach a limiter to a route, unless limits are switched off.
 *
 * Routes ask for limits through this rather than calling the factories
 * directly, so that the test suite — which runs every request from one address
 * and would otherwise start refusing itself — turns them off in one place. The
 * factories stay exported so a test can still build a limiter with small
 * numbers and check that it actually refuses.
 */
export const limit = (factory) => (config.RATE_LIMIT_ENABLED ? factory() : passThrough);

/**
 * Sign-in, sign-up and password reset.
 *
 * `skipSuccessfulRequests` is the whole design. Counting only *failures* means
 * a real person never spends budget — they sign in, it works, nothing is
 * counted — while someone guessing passwords spends it on every attempt. That
 * matters here beyond the usual reason: twenty people sharing one shop's wifi
 * are one IP address, and a limiter that counted their successful sign-ins
 * would take the demo down instead of an attacker.
 *
 * The cost being defended is not only the guess. scrypt at N=2^15 is about
 * 100ms of CPU per attempt, deliberately, and the deployment has two vCPU —
 * so unauthenticated sign-in spam is a way to exhaust the processor without
 * ever guessing anything. The PIN has its own three-strike lockout; this is
 * the equivalent for the password, which had none.
 */
export function authLimiter(options = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: refuse(
      'too_many_attempts',
      'Too many failed attempts. Wait a few minutes and try again.',
    ),
    ...options,
  });
}

/**
 * Opening an enrollment or a verification session.
 *
 * The gate is here rather than on the frames, because a session is what the
 * frames need and it is the request that writes a row. Frames are left alone
 * on purpose: one scan is 20-30 of them, arriving as fast as the round trip
 * allows, and a limit tight enough to matter there would reject customers
 * mid-scan on a slow connection.
 */
export function sessionLimiter(options = {}) {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: refuse(
      'too_many_sessions',
      'Too many scans started from here. Wait a few minutes.',
    ),
    ...options,
  });
}

/**
 * Everything else, as a backstop.
 *
 * Set well above what a busy terminal does — a scan is roughly 30 requests, so
 * this allows about forty scans in five minutes from one address — because its
 * job is to stop a flood of 8MB bodies, not to police ordinary use.
 */
export function globalLimiter(options = {}) {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 1200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: refuse('too_many_requests', 'Too many requests. Slow down.'),
    ...options,
  });
}
