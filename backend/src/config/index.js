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

  // Candidate pool narrowing. At demo scale everyone is a candidate; these are
  // the levers that keep the pool bounded as enrollment grows.
  CANDIDATE_POOL_ACTIVE_DAYS: z.coerce.number().int().positive().default(180),
  CANDIDATE_POOL_MAX: z.coerce.number().int().positive().default(5000),

  // Below this many active users, narrowing is skipped entirely and everyone
  // is a candidate. A few hundred 512-d dot products is under a millisecond,
  // so narrowing would buy nothing while adding a way to miss a real user.
  CANDIDATE_POOL_NARROW_ABOVE: z.coerce.number().int().positive().default(500),
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
});
