# Backend — API, storage and orchestration

The layer between the kiosk and the ML service. It owns everything the ML
service deliberately does not: the database, the encryption key, merchant and
device context, and the audit trail.

## Setup

```bash
npm install
npm run keygen          # prints ENCRYPTION_KEY=...
```

Put that line in `.env` alongside the rest:

```
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/facepay
ML_SERVICE_URL=http://127.0.0.1:8001
ENCRYPTION_KEY=<the 64 hex characters keygen printed>
ENCRYPTION_KEY_VERSION=1
```

There is no fallback key. The server refuses to start without one — a default
would mean every deployment that forgot to set it shared the same key, and the
embeddings it protects are biometric data that cannot be reissued the way a
password can.

```bash
npm start               # needs MongoDB and the ML service running
npm test                # 41 tests, no external services needed
```

## Trying it end to end

The ML service ships a webcam client that drives this API, so the whole flow
works before any frontend exists:

```bash
# terminal 1
cd ml-service && python app.py
# terminal 2
cd backend && npm start
# terminal 3
cd ml-service
python tools/kiosk_demo.py enroll --name "Your Name" --region delhi
python tools/kiosk_demo.py verify --merchant shop-1
```

## API

```
POST /api/enroll/start      -> sessionId, samplesRequired, guidance
POST /api/enroll/capture    -> accepted, samplesCollected, reason
POST /api/enroll/finalize   -> userId, enrollment quality

POST /api/verify/start      -> sessionId, prompt, totalSteps
POST /api/verify/frame      -> status, prompt, stepProgress, readyToMatch
POST /api/verify/match      -> decision, user, confidence, nextStep

GET  /health                -> this service and the ML service behind it
```

A rejected enrollment frame comes back as `200 { accepted: false, reason }`,
not an error. A blurry frame is part of the normal flow — the kiosk should show
the reason and keep capturing rather than starting the session over.

`/api/verify/match` returns one of three decisions, and they mean different
things to the kiosk:

| decision | `nextStep` | meaning |
|---|---|---|
| `matched` | `second_factor` | one identity, clearly ahead of the runner-up |
| `ambiguous` | `disambiguate` | top two too close to separate — the second factor decides, and the system must not guess |
| `no_match` | `reject` | nobody enrolled looks like this |

## How embeddings are stored

AES-256-GCM, as `version(1) || iv(12) || authTag(16) || ciphertext`. A stored
512-dimension embedding is 2077 bytes against a raw 2048, which is a quick way
to confirm from the shell that a record really is encrypted.

GCM rather than CBC because it authenticates as well as encrypts. An embedding
is what identity decisions are made from, so a record altered by someone with
database access has to fail loudly rather than decrypt into plausible garbage
that then gets matched against. The key version is stored per record so a
rotation can re-encrypt gradually instead of rewriting everything at once.

Raw face images are never stored anywhere. Neither is a phone number, an email,
or anything else that could identify a person off the system — 1:N
identification means nothing here needs to look anyone up by a contact detail,
and a field that does not exist cannot leak.

## The candidate pool

`services/candidatePool.js` is the answer to "how does 1:N scale". Since the
customer presents no identifier, every enrolled user is a potential match, and
the system-level false match rate grows roughly as `N x per-comparison FMR` —
so an unbounded pool costs accuracy, not just speed.

Narrowing uses only what the terminal already knows about itself: its region,
its own repeat customers, and whether a user is active at all. It never asks
the customer for anything.

Two rules keep it from breaking correctness:

- **It does not engage below `CANDIDATE_POOL_NARROW_ABOVE` users.** A few
  hundred 512-dimension dot products is under a millisecond, so narrowing buys
  nothing at that size while adding a way to miss a real user.
- **A user with no locality of their own is always in the pool.** Someone who
  enrolled an hour ago has no home region and has never paid anywhere, so a
  pure locality filter would exclude them from every pool — and since the only
  way into `knownMerchants` is to be identified, they could never be identified
  at any merchant, ever. This was a real bug, caught by a test asserting the
  gallery was actually populated.

The recall tradeoff that remains: someone who established a locality in one
city and then pays in another falls outside the narrowed pool. A production
system answers that with a tiered search — query narrow, widen on a miss — a
second round trip this does not yet make.

## The audit trail

`VerificationLog` is both the audit record and the entire dataset Phase 4's
fraud detection will run on. Anything not recorded is unrecoverable later, so
the schema keeps more than is needed today.

Two fields are easy to leave out and expensive to add back:

- **`thresholds`** records the values that produced each decision. Without them
  an old log cannot be reinterpreted after tuning, because there is no way to
  know whether a rejection was marginal or emphatic under the settings in force
  at the time.
- **`probeEmbedding`**, kept on failures only, is what allows the same
  unidentified face to be recognised turning up repeatedly across merchants —
  a far stronger fraud signal than a count of failed attempts. It is encrypted
  like any other embedding, and is not retained on a successful match, where it
  would only duplicate an identity already on file.

Liveness failures are logged too. They are the most interesting rows in the
table for fraud analysis, because a spoof attempt is what one looks like.

**Known gap:** a session the user simply abandons writes no row — it expires
via TTL and disappears. Repeated abandonment is a weak signal next to actual
failures, so this is left for Phase 4 rather than built now.

## Sessions

Kept in MongoDB with a TTL index rather than Redis. The design doc says Redis,
and Redis would be the right answer at scale — but this needs no second service
running during a demo and the connection is already open.

The tradeoff worth naming: MongoDB's TTL monitor sweeps about once a minute, so
a record can outlive its `expiresAt` by up to that long. Every read checks
`expiresAt` itself, so the lag is invisible.

## Error handling

`middleware/errorHandler.js` maps everything to one response shape and, notably,
never echoes an unexpected error's message back to the client. A stack trace or
a driver error can name collections, paths, or configuration, and a kiosk
screen is a poor place to publish any of it.

ML service faults are split deliberately: a 5xx or a timeout becomes `502`
because it is this system's problem, while a 4xx passes through with its own
status because the request itself was wrong. A test that stalls the ML service
past the timeout is what caught the first version getting this backwards.
