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
npm test                # 151 tests. Needs MongoDB; the ML service is stubbed
```

Handy scripts:

```bash
npm run users                     # who is enrolled, their scan history, failure mix
npm run fraud:replay -- --sweep   # every fraud rule over the whole log
npm run keygen                    # a new ENCRYPTION_KEY (see the warning above)
node src/scripts/seedMerchant.js  # create / approve / reset a shop account
node src/scripts/dedupe.js        # duplicate registrations, dry run
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

27 routes. Who may call each one is the important column.

**Open — the kiosk, no account needed**

```
POST /api/enroll/start      -> sessionId, samplesRequired, guidance
POST /api/enroll/capture    -> accepted, samplesCollected, reason
POST /api/enroll/finalize   -> userId, enrollment quality

POST /api/verify/start      -> sessionId, prompt, totalSteps
POST /api/verify/frame      -> status, prompt, stepProgress, readyToMatch
POST /api/verify/match      -> decision, user, confidence, nextStep
POST /api/verify/confirm    -> PIN check, then the charge

GET  /health                -> this service and the ML service behind it
```

**Customer account** — `POST /api/user/claim` and `/login` are open; the rest
need a user token.

```
POST   /api/user/claim            attach an email + password to a scanned face
POST   /api/user/login
POST   /api/user/password/reset   forgot password: name + PIN
GET    /api/user/me
GET    /api/user/transactions
POST   /api/user/pin              forgot PIN: change it with the password
DELETE /api/user/me               delete the face data
```

**Shop** — `POST /api/merchant/register` and `/login` are open; the rest need a
merchant token.

```
POST /api/merchant/register       open a shop account (unapproved)
POST /api/merchant/login
GET  /api/merchant/me
GET  /api/merchant/stats
GET  /api/merchant/transactions
POST /api/merchant/charge
POST /api/merchant/verify/start   needs approval as well as a token
```

**Admin only** — the whole `/api/fraud` router is gated at the router, so a
route added later cannot forget to ask.

```
GET  /api/fraud/flags
GET  /api/fraud/flags/:id
POST /api/fraud/flags/:id/clear
POST /api/fraud/flags/:id/confirm
GET  /api/fraud/merchants/pending
POST /api/fraud/merchants/:id/verify
```

Three roles, three middlewares: `requireUser`, `requireMerchant`,
`requireAdmin`. Admins sign in through the merchant login endpoint and get a
token carrying `role: 'admin'` — one account table, one token format.

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

**The bug that made narrowing tiered.** Paying anywhere writes a
`knownMerchants` entry — which then disqualifies you from the "no locality of
their own yet" clause above. So from your second shop onwards you were outside
every narrowed pool but your regulars', and the system told you to register
again. It stayed invisible at nine users because narrowing does not engage below
`CANDIDATE_POOL_NARROW_ABOVE`; loading a real gallery turned it on and eight of
nine real users vanished at an unfamiliar merchant.

Narrowing is now only the **first tier**. A miss widens to the whole gallery
before anyone is turned away, and the audit row records which tier answered.

## The gallery cache

Building the candidate gallery was 961ms, and 97% of it was one Atlas round trip
for 5.6MB of ciphertext — repeated on every scan, for data that does not change
unless somebody enrols or deletes.

```
Atlas fetch of the encrypted rows       934 ms
decrypt                                  21 ms
serialise                                 6 ms
                                     ---------
                                        961 ms

after services/galleryCache.js:
first scan after a restart             1228 ms   two queries instead of one
every scan after that                   104 ms
```

**858ms off every verification.** The first scan is slower, once per process
lifetime — the price of splitting one query into two.

What the cache deliberately does *not* hold is the pool itself. Narrowing reads
`lastSeenAt`, `knownMerchants` and `homeRegion`, and all three move as people use
the system, so membership is still decided on every scan. Only the embeddings are
cached, and `tests/galleryCache.test.js` asserts the gallery is **identical** cold
and warm — same users, same order, same bytes — because the accuracy figures were
measured against the database path and have to keep describing the running system.

`GALLERY_CACHE_TTL_MS` (5 min) covers edits made from outside the process, such
as a script.

*Is caching decrypted embeddings a risk?* It is plaintext biometric data in
process memory, which is a real change. It is bounded: same process as the
decryption key, never written to disk, gone on restart. Anyone who can read that
memory already has the key.

## The audit trail

`VerificationLog` is both the audit record and the entire dataset the fraud
rules run on. Anything not recorded is unrecoverable later, so the schema keeps
more than is needed today.

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
failures, so it is not built.

## Fraud rules

`src/rules/` holds three, and `services/fraudRuleEngine.js` runs them on every
log write. It never throws — a rule that fails must not take a payment down with
it — and it collapses a burst into one incident rather than one flag per row.

| rule | fires at | severity |
|---|---|---|
| `pin_velocity` | 3 refused PINs in 5 min, naming the target | high_risk |
| `spoof_burst` | 3 presentation attacks in 5 min | suspicious |
| `liveness_velocity` | 5 liveness failures in 5 min, excluding attacks | review |

`npm run fraud:replay -- --sweep` re-runs every rule over the whole log at every
threshold. It imports `RULES` rather than restating them, so the printed numbers
cannot drift from the shipped code.

**Two more rules were specified and not built.** "Many distinct people at one
terminal" and "a spike in ambiguous results" fire zero times at every threshold
over all 290 real logs — there are 17 enrolled users and not one `ambiguous`
outcome in the file. Shipping them so the count reads four would be decoration.
`src/rules/index.js` records why.

**Not a trained model, deliberately.** There is no real fraud data to train on,
and training on invented fraud would be theatre. These same rows become labelled
training data once there is volume; that is the upgrade path, not a gap.

## Two authorization bugs worth knowing about

Both were found by reading the code rather than by anything failing.

**A terminal could say which shop it was.** `/api/verify/start` read `merchantId`
from the request body, and the approval check added alongside merchant sign-up
read the same field — so the gate was asking the caller which identity to check
them against. An unapproved shop simply sent the kiosk's id and scanned customers
anyway, learning the name of anyone who looked at its camera. The rule was
already written down one file away in `requireMerchant`: *a merchant id from a
request body is a value the caller chose, not an identity.* The public route now
accepts no shop id at all and books to a server-side constant; a till uses an
authenticated route and books to the shop in its token.

**A face could take away the PIN protecting it.** Re-enrolling overwrote
`pinHash` unconditionally — deliberately, as the way back for people who enrolled
while a PIN was optional. Present somebody's live face, choose a new PIN, and
their second factor is yours. Records now set `pinSealed` when their PIN is set,
and a sealed record refuses the whole enrollment rather than just the PIN, so a
stranger cannot even refresh the stored signature. `pinSealed` defaults to
`false`, so everything registered before this gets exactly one more pass through
the old route and seals behind it.

## Merchant approval

Anyone can open a shop account and it grants nothing: the terminal can sign in
and read its own empty ledger, and that is all. Starting a scan needs approval,
from `/fraud` or `seedMerchant.js --verify <email>`.

The split is not about money — charging already needs the customer's own PIN, so
a hostile shop cannot take anything. What an unapproved terminal could do is
point a camera at a queue and be told everybody's name. It is a privacy surface
before it is a payment one, and that is what approval gates.

Self-registered shops get a random suffix on their id (`corner-store-a3f9c1`).
The id is stamped on every transaction and sits in every customer's
`knownMerchants`, so it cannot be swapped later; deriving it from the name alone
would let the first person to sign up as "Corner Store" take the id the real one
would want.

`verified` defaults to `true` so accounts created from the command line, and
every account that existed before this feature, keep working without a migration.

## Getting back in

Neither route is the face. A face that could reset the PIN would make the PIN
decorative, which is the whole reason it exists.

- **Forgot password** — registered name + PIN, through the same three-strike
  lockout that guards the PIN everywhere else. Wrong email, wrong name and wrong
  PIN all answer identically, so this cannot be used to discover which addresses
  are registered.
- **Forgot PIN** — the account password, while signed in.
- **A shop forgot its password** — nothing automatic. A customer can prove
  themselves with a PIN and a face; a shop account has neither, and nothing here
  sends mail. `seedMerchant.js --reset-password`.

## Sessions

Kept in MongoDB with a TTL index rather than Redis. The design doc says Redis,
and Redis would be the right answer at scale — but this needs no second service
running during a demo and the connection is already open.

The tradeoff worth naming: MongoDB's TTL monitor sweeps about once a minute, so
a record can outlive its `expiresAt` by up to that long. Every read checks
`expiresAt` itself, so the lag is invisible.

## Request limits

Three tiers, in `middleware/rateLimit.js`. One global limit either sits high
enough to be useless against password guessing or low enough to break a
verification, which is 20-30 requests for one customer standing at a till.

| tier | where | limit |
|---|---|---|
| auth | sign-in, sign-up, password reset | 20 **failures** / 15 min |
| session | `/enroll/start`, `/verify/start`, `/merchant/verify/start` | 30 / 5 min |
| global | everything | 1200 / 5 min |

**Counting only failures is the whole design of the auth tier.** A real person
signs in, it works, nothing is counted; someone guessing spends budget on every
attempt. That matters beyond the usual reason — twenty people sharing one shop's
wifi are one IP address, and a limiter that counted their successful sign-ins
would take a demo down instead of an attacker.

**The cost being defended is not only the guess.** scrypt at `N=2^15` is about
100ms of CPU per attempt, deliberately, and the deployment has two vCPU. So
unauthenticated sign-in spam was a way to exhaust the processor without ever
guessing anything. The PIN already had a three-strike lockout; the password had
nothing, and this is its equivalent.

**Frames are deliberately not limited.** One scan is 20-30 of them arriving as
fast as the round trip allows. The gate is on opening a session instead — that
is the request that writes a row, and frames cannot be sent without one.

Limits are in-process memory, which is correct **only because the deployment
runs one replica** (liveness sessions require that anyway — see `DEPLOY.md`). A
second replica needs a shared store, or each enforces its own fraction.

`RATE_LIMIT_ENABLED=false` in `tests/test.env`, because 151 tests from one
address would otherwise refuse each other. `tests/rateLimit.test.js` builds its
own limiters with small numbers to check they really refuse.

`TRUST_PROXY` defaults to 1. Every host in `DEPLOY.md` puts exactly one proxy in
front, and without this Express reads the proxy's address as the client's —
which would file the entire internet into one bucket. A number rather than
`true`, because trusting every hop lets a caller set `X-Forwarded-For` and
choose which bucket to spend.

## Security headers

`helmet`, configured rather than defaulted, because this process serves the
kiosk HTML as well as the API.

- **`frame-ancestors 'none'`** — a payment button inside somebody else's iframe
  is a click waiting to be stolen.
- **`script-src 'self'`, no `unsafe-inline`** — the directive that actually
  stops injected markup executing. Affordable because there is no CDN, no
  analytics and no inline script: the build emits hashed files from this origin.
- **`style-src` does allow `unsafe-inline`** — a far weaker vector, and needed
  because the landing page writes scroll progress into a style attribute. Without
  it the page loads and silently never animates.
- **`img-src data:` and `media-src blob:`** — a captured frame is a data URL, and
  the camera preview is a blob source. Omitting these breaks the camera with no
  visible error.

`CORS_ORIGINS` now defaults to **empty**, not `*`. The way this deploys, the
Node service serves the frontend itself, so every request is same-origin and
needs no CORS header at all. `*` is still accepted for a split deployment — it
just has to be asked for rather than inherited.

## Error handling

`middleware/errorHandler.js` maps everything to one response shape and, notably,
never echoes an unexpected error's message back to the client. A stack trace or
a driver error can name collections, paths, or configuration, and a kiosk
screen is a poor place to publish any of it.

ML service faults are split deliberately: a 5xx or a timeout becomes `502`
because it is this system's problem, while a 4xx passes through with its own
status because the request itself was wrong. A test that stalls the ML service
past the timeout is what caught the first version getting this backwards.
