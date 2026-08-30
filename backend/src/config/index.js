import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

// 32 bytes as hex — the key size AES-256 requires.
const ENCRYPTION_KEY_HEX_LENGTH = 64;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/facepay'),
  ML_SERVICE_URL: z.string().default('http://127.0.0.1:8001'),
  ML_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // Deliberately has no default. A fallback key would mean every deployment
  // that forgot to set one shared it, and the embeddings it protects are
  // biometric data that cannot be reissued the way a password can. Refusing to
  // start is the only safe behaviour.
  ENCRYPTION_KEY: z
    .string({ error: 'ENCRYPTION_KEY is required — run: npm run keygen' })
    .regex(
      new RegExp(`^[0-9a-fA-F]{${ENCRYPTION_KEY_HEX_LENGTH}}$`),
      `ENCRYPTION_KEY must be ${ENCRYPTION_KEY_HEX_LENGTH} hex characters (32 bytes)`,
    ),

  // Bumped when the key is rotated. Stored alongside every ciphertext so old
  // records stay decryptable while new ones use the new key.
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

  // Overrides for the matching thresholds the ML service applies. Left unset,
  // the ML service uses its own calibrated defaults — which is what you want
  // unless you are deliberately sweeping values.
  MATCH_THRESHOLD: z.coerce.number().min(-1).max(1).optional(),
  MATCH_MARGIN: z.coerce.number().min(0).max(2).optional(),

  // How long a half-finished enrollment or verification survives. Must exceed
  // the ML service's own session TTL, or Node would still be holding a session
  // the ML service has already dropped.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // Verification attempts allowed per session before it is abandoned. Caps how
  // many tries an attacker gets at the margin rule with one face.
  MAX_VERIFICATION_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // Razorpay test-mode credentials. Optional: without them the service runs
  // exactly as before and payment endpoints report that they are unconfigured,
  // rather than failing somewhere deeper with a less obvious message.
  RAZORPAY_KEY_ID: z
    .string()
    .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'not a Razorpay key id')
    .optional(),
  RAZORPAY_KEY_SECRET: z.string().min(10).optional(),

  // How long a merchant stays signed in at a terminal. Long enough for a
  // day's trading, short enough that an unattended terminal expires.
  MERCHANT_SESSION_HOURS: z.coerce.number().positive().default(12),
  // The customer portal is read-mostly and used from a personal phone, so a
  // longer session costs less than making someone sign in every visit. Still
  // finite: these tokens cannot be revoked before they expire.
  USER_SESSION_HOURS: z.coerce.number().positive().default(72),

  // Comma-separated origins allowed to call this API from a browser. Empty by
  // default, which is the right default for the way this actually deploys:
  // the Node service serves the built frontend itself, so every request is
  // same-origin and needs no CORS header at all.
  //
  // "*" is still accepted, and is what a split deployment on an unknown
  // frontend origin needs. It is tolerable only because the API uses no
  // cookies and no browser-managed credentials — session ids and bearer
  // tokens are sent by the page, so another site loading this API in a user's
  // browser gains nothing it could not get by calling the API directly. It
  // has to be asked for rather than inherited.
  CORS_ORIGINS: z.string().default(''),

  // How many reverse proxies sit in front of this process. Every platform in
  // DEPLOY.md puts exactly one there, and without this Express reads the
  // proxy's own address as the client's — which would file every request in
  // the world under one rate-limit bucket and take the whole API down the
  // first time anybody hit a limit.
  //
  // A number rather than `true`: trusting every hop lets a caller set
  // X-Forwarded-For themselves and pick which bucket to spend.
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  // Off in the test suite, where 141 tests share one address and would
  // otherwise start refusing each other. Never turn it off in a deployment.
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  // Candidate pool narrowing. At demo scale everyone is a candidate; these are
  // the levers that keep the pool bounded as enrollment grows.
  CANDIDATE_POOL_ACTIVE_DAYS: z.coerce.number().int().positive().default(180),
  // The shop id the public kiosk books its sessions under. Fixed here
  // rather than taken from the request, because a caller that can name a
  // shop can borrow one -- see startVerification.
  KIOSK_MERCHANT_ID: z.string().trim().min(1).default('demo-shop'),

  // The area the public kiosk stands in, used to narrow the candidate pool.
  // A deployment fact rather than a database one, and set here rather than
  // read from the request for the same reason the shop id is: a region from
  // a request body is a value the caller chose.
  //
  // Null by default, which simply means the kiosk does not narrow by area --
  // repeat-customer history still does. Set it to the same string the local
  // shops use (`delhi`, `sector-18`) and the two work together.
  KIOSK_REGION: z.string().trim().nullish().transform((v) => v || null),

  CANDIDATE_POOL_MAX: z.coerce.number().int().positive().default(5000),

  // Below this many active users, narrowing is skipped entirely and everyone
  // is a candidate. A few hundred 512-d dot products is under a millisecond,
  // so narrowing would buy nothing while adding a way to miss a real user.
  CANDIDATE_POOL_NARROW_ABOVE: z.coerce.number().int().positive().default(500),

  // How long a cached face signature may go unchecked. Every path in the
  // API that changes one invalidates it immediately, so this only covers
  // edits made from outside this process -- the dedupe and benchmark
  // scripts -- which otherwise need a restart to take effect.
  GALLERY_CACHE_TTL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',

  // Payments are an optional capability. Checking it in one place keeps every
  // caller from having to test two variables and guess what a half-configured
  // deployment means.
  paymentsEnabled: Boolean(
    parsed.data.RAZORPAY_KEY_ID && parsed.data.RAZORPAY_KEY_SECRET,
  ),
});

if (parsed.data.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) {
  // A live key in a prototype would move real money on a face match that has
  // had no security review. Refusing outright beats a warning nobody reads.
  throw new Error(
    'RAZORPAY_KEY_ID is a live key. This is a prototype — use a test key ' +
      '(rzp_test_...) so no real money can move.',
  );
}
