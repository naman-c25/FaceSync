# FaceSync

Pay at a shop without a phone, a card, or an app. Walk up, and the camera works
out who you are.

A prototype for the Razorpay hackathon, and it runs end to end: face detection,
passive liveness, anti-spoofing, 1:N identification, a four-digit PIN, a
Razorpay test-mode charge, a printable receipt, and an audit trail of every
attempt.

Live at **https://facesync-production.up.railway.app** — kiosk at `/`, merchant
till at `/merchant`, customer portal at `/user`.

The product is FaceSync. The directories, environment variables and storage
keys still say FacePay, which is what it was called first; renaming those would
churn every deployed secret for nothing.

## Why 1:N is the whole point

The customer presents **no identifier**. Not a phone number, not a card, not a
name. That is what separates this from Aadhaar face auth or a fingerprint POS,
where you enter a number first and the biometric only confirms it.

It also makes the problem genuinely harder, and the design follows from that:

- Every enrolled user is a potential match, so the system-level false match
  rate grows roughly as `N × per-comparison FMR`.
- A plain threshold check is therefore not enough. The best match must also
  beat the runner-up by a margin, or the answer is `ambiguous` — the system
  says it does not know rather than picking the higher of two near-equal
  scores.
- Keeping the comparison count bounded is done with what the terminal already
  knows about itself (its region, its own repeat customers), never by asking
  the customer for anything.

## Layout

```
ml-service/   Python — face detection, liveness, embeddings, matching
backend/      Node — API, MongoDB, encryption, the audit trail
frontend/     React — three entry points, chosen by path
```

Each has its own README with the detail. Short version:

- **ml-service** does the ML and nothing else. No database, no keys, no user
  records.
- **backend** owns all of that and calls the ML service with frames, then with
  a candidate pool to match against.
- **frontend** is three separate apps sharing one stylesheet: the kiosk (`/`),
  the merchant till (`/merchant`) and the customer portal (`/user`). They are
  split by path rather than folded together, because nothing customer-facing
  should carry code that charges money.

## Running the whole thing

Needs MongoDB running locally.

```bash
# 1. ML service
cd ml-service
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements.txt
python setup_models.py          # ~300MB, once
python app.py                   # :8001

# 2. Backend
cd backend
npm install
npm run keygen                  # put the output in .env, see backend/README
npm start                       # :3000

# 3. Frontend
cd frontend
npm install
npm run dev                     # :5173
```

There is also a webcam CLI that drives the API without a browser:

```bash
cd ml-service
python tools/kiosk_demo.py enroll --name "Your Name"
python tools/kiosk_demo.py verify --merchant shop-1
```

## Tests

```bash
cd ml-service && pytest         # 237  (221 without the model-loading ones)
cd backend && npm test          # 148  (needs MongoDB; the ML service is stubbed)
cd frontend && npm run lint     # rules-of-hooks, mainly
```

All of it runs on every push — `.github/workflows/ci.yml` builds the Docker
image too, since that image is the deployed artefact and a Dockerfile that
stopped building would otherwise surface only as a failed deploy.

The liveness state machine is tested against synthetic landmark geometry, so
every spoof scenario — a held photo, a replayed blink, a head turned at rest —
runs without a camera.

## Every dataset used, and what for

Five, and none of them were trained on. **No model here is trained or
fine-tuned** — the weights are pretrained and the work is in the thresholds and
the rules around them.

**1. Labeled Faces in the Wild (LFW), funneled** — 13,233 photos of 5,749
people, public research data.

| used for | how much | why |
|---|---|---|
| the 1:N benchmark | 5,486 identities embedded, 5,182 in the measured gallery | eight friends cannot test 1:N; system FMR grows as `N x` per-comparison FMR |
| loaded into the real database | 2,000 identities | measure the actual code path, encryption and all, not a script |
| the bucketing experiment | 5,486 embeddings | needed a gallery wide enough for the pruning test to mean something |
| PAD domain-shift check | 120 captures of real people | see whether the anti-spoof models call strangers' cameras fake. 9.2% were |

*Why not an Indian face dataset* — no free one of this size with multiple dated
photos per person was found. This is the honest gap: LFW is mid-2000s
English-language press photography, heavily skewed toward white American men,
and error rates vary by demographic group. A threshold validated here is not
thereby validated for the people this is built for.

*Why the benchmark rows cannot be paid* — nobody in a research dataset agreed to
be in a payment system. They sit in the candidate pool (that is the point) but
carry `source: 'benchmark'`, have no PIN, and two code paths refuse them by
name. See `benchmark-data/README.md`.

**2. Silent-Face-Anti-Spoofing reference images** — 8 labelled images shipped by
the model authors: print attacks, screen attacks, live faces. Used once, to
check the PAD pipeline end to end. **Not used to set the threshold** — 8 images
cannot calibrate anything. That is what the 120 LFW captures were for, and even
those are a domain-shift check rather than a calibration.

**3. Our own captures — the only data from the real cameras.** 17 enrolled
users, 290 verification attempts over 6.7 days across 14 terminals. Small, and
the most relevant thing here.

| used for | how much |
|---|---|
| blink thresholds | 5 people, open-eye EAR 0.316-0.418 |
| challenge-mode cost | 86 attempts — median 8.0s, 1 in 5 failed |
| the continuity threshold | 28 genuine sessions, 0.481-0.984 |
| PAD scores in the wild | 131 attempts with a spoof score recorded |

*Why it is not the accuracy number* — 9 of the 17 have been scanned once or
never. Their scores are not evidence yet, and the README says so where they
appear.

**4. The six-person group photo bundled with InsightFace** — 15 impostor pairs.
The first threshold sanity check, before LFW was set up: highest impostor pair
0.194, mean 0.034, against a 0.45 threshold.

*Why it is not quoted as accuracy.* 15 pairs from one photograph is a smoke
test. It said the threshold was not obviously wrong, which is all it can say.
LFW replaced it.

**5. Pretrained model weights** — `buffalo_l` (SCRFD + ArcFace), MediaPipe
FaceLandmarker, two MiniFASNets. Downloaded, converted to ONNX, and run as-is.
`allowed_modules` is limited to detection and recognition, so the gender, age
and dense-landmark models in the bundle never load or run.

*Why nothing was trained.* There is no data here worth training on. 17 users is
not a training set. Every threshold here was measured and set by hand, which
is what the numbers below are.

## What has been measured

### 1:N at a realistic gallery size

The claim this project rests on is that a face alone can identify someone out of
a crowd. A gallery of eight friends cannot test that: the false match rate of
the whole system grows roughly as N times the rate of one comparison, so "nobody
was confused with seven other people" is close to no evidence at all.

So the gallery was filled with **5,182 real, distinct faces** from the Labeled
Faces in the Wild benchmark, one photograph enrolled per person and a second
photograph from a different day held out as the probe. Reproduce it with
`benchmark-data/README.md`; the measurement is `ml-service/tools/benchmark_1n.py`
and it runs `recognition.identify` itself rather than a copy of the rule.

**Impostor scores, 13,423,971 cross-identity pairs**

```
median   0.0102     p99.9   0.2110     max   0.7745
p99      0.1533     p99.99  0.2669

26 pairs (0.0002%) reach the 0.45 match threshold
```

**Identification, threshold 0.45 and margin 0.08, N = 5,182**

```
enrolled people, held-out photo    strangers, never enrolled
  correct        96.3%               correctly refused   297
  WRONG PERSON    0.0%               falsely matched       3   (1.0%)
  ambiguous         6
  no match         38
```

**The runner-up margin earns its place, measurably.** The same probes against
the same gallery, decided with and without it:

```
margin 0.00   ->  0.17% wrong person
margin 0.08   ->  0.00% wrong person
```

That is the whole argument for the two-condition rule in one line. A plain
threshold names a winner when the top two candidates are a coin flip; the margin
refuses, and every wrong-person match at this scale was a near-tie.

**All three remaining false matches are worth naming**, because a percentage
cannot tell you what kind of problem you have:

```
0.7254  Carolina Moraes -> Isabela Moraes    identical twins
0.6603  Claire Hentzen  -> Morgan Hentzen     siblings
0.5134  Wang Yingfan    -> Yingfan Wang       one person, name order reversed
```

Twins are a real limit of face recognition and no threshold fixes them. They are
also the clearest argument for the PIN: the face says who, the PIN says approve,
and a twin does not know their sibling's PIN.

**Two kinds of dataset error had to be handled first**, and both are reported
rather than quietly dropped. Four pairs of identities scoring above 0.85 turned
out to be one person filed under two names — Andrew Caldecott and Andrew
Gilligan at 0.956 are literally the same photograph. Six probes matched somebody
else while scoring near zero against their own row, which is a folder holding
two different people: Kate Capshaw's second photograph is Steven Spielberg's.
Counting those as recognition failures would have reported 0.51% wrong-person
instead of 0.00%.

**What this does not measure.** LFW is mid-2000s English-language press
photography, heavily skewed toward white American men, and FaceSync is for Indian
customers. Error rates vary by demographic group, so a threshold validated here
is not thereby validated there. It is also a harder test than the real system
faces — one press photograph enrolled, versus five fused samples in steady light
at a kiosk.

### The real system, with real people in it

2,000 of those faces were loaded into the actual database, encrypted through the
actual code path, and the nine real users enrolled at the time measured against them
(`backend/src/scripts/measureAccuracy.js`):

```
18,000 real-vs-benchmark comparisons
  median  -0.0022     p99.9  0.1786     max  0.2233
  at or above 0.45:  0
```

Every real user stays far clear of two thousand strangers, and for all nine the
nearest impostor is still another real user rather than any benchmark face.
Adding 2,000 people cost them no safety margin at all.

### Where the time goes, and when a vector database starts to matter

Measured at N = 2,009 on the live stack:

```
the cosine similarity itself            0.079 ms
identify() including ranking            2.0   ms
```

The matching is free. Everything that hurt was around it, and breaking the
gallery build into its three stages at N = 2,017 said exactly where:

```
Atlas fetch of the encrypted rows       934 ms   <- 5.6MB per payment
decrypt                                  21 ms
serialise the payload                     6 ms
                                     ------------
                                        961 ms
```

Ninety-seven per cent of it was one network round trip, repeated on every
single scan, for data that does not change unless somebody enrols or deletes.
So the signatures are now held in memory (`services/galleryCache.js`) and the
query asks for ids instead of ciphertext:

```
first scan after a restart             1228 ms   <- two queries instead of one
every scan after that                   104 ms
```

**858ms off every verification**, and the remaining 104ms is two small Atlas
round trips for metadata — the active count that decides whether to narrow, and
the ids themselves. The first scan is slower than it used to be, once per
process lifetime, which is the price of splitting one query into two.

What the cache deliberately does *not* hold is the pool itself. Narrowing reads
`lastSeenAt`, `knownMerchants` and `homeRegion`, and all three move as people
use the system, so membership is still decided on every scan. Only the
embeddings are cached, and `tests/galleryCache.test.js` asserts the gallery is
**identical** cold and warm — same users, same order, same bytes — because the
accuracy figures above were measured against the database path and have to keep
describing the running system.

This is also the honest answer to "do we need a vector database". Not for
accuracy and not for speed: the search was never the slow part.

### The gallery moved out of the request

Every match used to ship the whole candidate pool to the ML service: 5.6MB of
base64 at two thousand users, serialised in Node, parsed in Python, then decoded
one entry at a time into a list that `np.stack` immediately copied into a fresh
matrix -- once per scan, for vectors that do not change between scans.

It is pushed once now and a scan sends ids. Measured against the real service:

```
                    payload             latency        decision
N = 2,017    5.60 MB -> 23 KB     50.5 -> 3.0 ms      identical
N = 5,486   15.23 MB -> 58 KB    138.3 -> 6.2 ms      identical
```

**Identical is the word that matters.** A speed change to the matching path is
only acceptable if it is provably not an accuracy change, so `identify` was
refactored to delegate to the same function the new path calls -- one
implementation, two entry points -- and `test_gallery_store.py` asserts that 300
probes give bit-equal top scores, runner-up scores and margins either way.

A stale gallery is refused rather than answered, because one missing the person
standing at the till returns `no_match`, which looks exactly like a stranger.
Node re-pushes and retries; a failed push falls back to shipping the vectors
inline, so a sync problem costs speed and not service.

The gallery is also warmed at boot rather than on the first customer. At ten
thousand signatures the cold build ran about 30 seconds against a 15-second ML
timeout, so the first scan after a deploy did not merely feel slow -- it failed.

### Bucketing the gallery, and why it cannot help

The obvious next idea is the one every vector index uses: cluster the gallery
and only search the promising clusters. Approximate versions of that are off the
table here — the margin rule needs the true runner-up, and an index that misses
it reports a *wider* margin than really exists, turning an `ambiguous` into a
confident wrong name.

So `tools/bucketed_gallery.py` implements the exact version instead. Cluster the
embeddings, and bound each bucket by the triangle inequality: nothing inside a
bucket can score higher than `centre · probe + radius`. Visit buckets in
descending order of that ceiling and stop when it drops below the fifth-best
score found so far — provably safe, because a bucket is only skipped once it
*cannot* contain a better answer.

It works, and it is useless. `tools/bucket_check.py`, over the 5,486 real
embeddings in `benchmark-data/`:

```
                   compared        time      vs full scan
N = 2,017     2,017 of 2,017     0.251 ms      3.6x slower
N = 5,000     5,000 of 5,000     0.674 ms      7.7x slower
full scan                   0.070 / 0.088 ms
```

The top five come back identical on every probe, and **not one bucket was ever
pruned**. In 512 dimensions a cluster of faces has a radius close to the √2 that
separates two arbitrary unit vectors, while `centre · probe` spans a much
narrower range — so every ceiling sits above every achievable score and the
skip test never fires. That is the curse of dimensionality, not a tuning
problem, and it is exactly why production indexes are approximate: exact metric
pruning does not work at this width.

Which settles it. You may have exact answers or you may have pruning; at 512
dimensions you cannot have both, and the margin rule makes exact
non-negotiable. Once pruning is gone, `matrix @ probe` is already the best
available — BLAS goes from 2,017 rows to 5,000 for 1.3x the time, so a hundred
thousand would still be about two milliseconds.

### Liveness

**Blink thresholds across five people.** Open-eye EAR ranged 0.316 to 0.418, a
32% spread, while the ratio of blink floor to open eye held between 16% and
22%. That is why the blink threshold scales to each person's own measured open
eye rather than being a fixed number.

Every attempt is logged with both scores, the thresholds in force, and the full
liveness signals, so these curves are drawn from real attempts rather than
estimated.

### What the audit trail says about failures

290 attempts over 6.7 days across 14 terminals, our own testing:

```
matched            177   61.0%
liveness_failed     76   26.2%
capture_failed      27    9.3%
no_match             6    2.1%
pin_failed           4    1.4%
```

Liveness failures are the largest single kind by a wide margin, and they are
mostly light rather than attacks. That is measurable in the log: the anti-spoof
score for a genuine face runs 0.88-0.99 in daylight and drops to 0.55-0.60 near
midnight, against a threshold of 0.70 — so the same person is accepted in the
afternoon and refused at night. See the note on calibration below.

## Liveness: what is running, and what that buys

The service has two liveness modes, and which one is on changes what the face
factor is worth. `FACEPAY_LIVENESS_MODE` switches between them.

**`challenge`** — a randomised prompt: blink twice, or look left, or look
right, chosen per session with `secrets`. A printed photograph cannot perform
an action it has not been shown, so this is genuine presentation attack
detection against print, and against replay to the extent that a recording
cannot answer a prompt it has never seen.

Measured across 86 real attempts, it cost a median 8.0 seconds with two steps
and failed one attempt in five. One step roughly halves that.

**`passive`** — the mode the demo runs. No prompt and nothing asked: the
service watches a face for about a second and a half, then hands the frame to
the anti-spoof models below.

Turning the challenge back on is one environment variable, and its tests and
measurements are all still in the tree.

### Presentation attack detection

Two MiniFASNets from
[minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing)
(Apache-2.0), converted to ONNX. 3.4MB together, running on the ONNX Runtime
already loaded for ArcFace, and they classify three ways: paper photo, real
face, screen photo. Run once per session on the frame the payment rests on.

Against the reference project's own labelled images, through this pipeline:

```
image_F1  screen   crop 2.47   real 0.181   BLOCKED
image_F2  screen   crop 2.05   real 0.002   BLOCKED
image_F3  screen   crop 2.62   real 0.144   BLOCKED
image_F5  paper    crop 1.90   real 0.000   BLOCKED
image_T1  live     crop 2.61   real 1.000   allowed
image_T2  live     crop 1.95   real 0.999   allowed
```

Two others never reach the models: one has no detectable face, and one is a
composite holding two faces of comparable size, which the dominance rule
refuses first.

**The crop is the whole thing.** The numbers in the model filenames are
bounding-box expansion factors, and each model was trained on a crop of its own
size. Handed something tighter they still answer, still confidently, and the
answer is worth nothing. The reference clamps silently when the expansion will
not fit — which turns out to be the normal path, since every reference sample
clamps to between 1.90 and 2.62 and is classified correctly there. What is not
normal is clamping far down: the single sample the models get wrong is also the
only one whose crop collapses to 1.21. So there is a floor rather than an exact
fit, and below it the verdict is *no verdict* rather than a bad one.

That is also why the kiosk's framing oval is sized the way it is: 51% of frame
height, where 144 real attempts put the median achieved crop at 2.35, inside
the band the models classify correctly. It began at 63%, which starved them.
Growing it further is measurable rather than arguable -- at 55% a quarter of
attempts fall short of 1.90 and at 60% it is over forty per cent.

**What this does not claim.** The threshold has not yet been calibrated on the
camera it will run on, and the authors of the models state the limitation
plainly themselves: "limited robustness to camera model type and usage
scenarios". Measured here across a domain shift — 120 LFW captures of real
people — 9.2% were called attacks, which is why `tools/silent_pad.py --data`
exists to re-measure on real captures before the threshold moves.

### Two passive checks that were measured and abandoned

Both were built, measured and rejected before reaching for a trained model, and
both failed for the same reason.

*Planar versus 3D.* A real face is a solid and a photograph is a plane, so
align two views with the best-fitting homography and a real face should leave a
residual a flat picture cannot. It does — but to turn away 97% of photographs
it refuses one real customer in ten, and the test flattered it, since its "real"
pairs were press photographs years apart rather than someone holding still for a
second at a kiosk.

*Gaze and eyelid micromotion.* A photograph's gaze is fixed; a living eye
microsaccades several times a second. Real passive scans move gaze by
0.032–0.168 over their window. A photograph in an unsteady hand moves it by a
median of 0.038 — 65% of held photographs reach the floor no live scan fell
below.

Both measured *geometry*, and on a moving image landmark noise is the same size
as the biological signal. The models above look at pixels instead, which is a
different signal and not the one landmark noise destroys.

## Bugs worth knowing about, because they shaped the design

Each of these looked like a working system until something specific caught it.

- **A held photo passed a look step.** The check compared absolute head angle,
  and someone photographed mid-turn sits permanently past any threshold loose
  enough to accept real people. Look steps now score *movement from a
  baseline*, which a fixed pose cannot fake.
- **Turning your head manufactured blinks.** EAR divides eyelid height by eye
  width, and eye width foreshortens as the head turns — a live tool measured an
  "open eye" at 1.414. A challenge could be passed by turning the head back and
  forth without blinking once. EAR is now only read on a roughly frontal face.
- **Following the prompt failed the challenge.** Turning to look right
  motion-blurs the frames mid-turn; those were discarded by the
  embedding-quality gate before detection ran, and a run of discarded frames
  read as the face having left. Liveness has its own, much lower, sharpness
  floor.
- **A newly enrolled user could never be identified anywhere.** The candidate
  pool filtered on merchant history, and the only way into that history is to
  be identified. Narrowing no longer engages below a configured gallery size,
  and always keeps users who have no locality of their own yet.
- **A registered customer could not pay at a new shop.** The candidate pool
  narrows by locality, and paying anywhere writes a `knownMerchants` entry —
  which then disqualifies you from the "no locality of their own yet" clause
  that was supposed to protect newcomers. So from your second shop onwards you
  were outside every narrowed pool but your regulars', and the system told you
  to register again. It stayed invisible while there were nine users, because
  narrowing does not engage below a configured size; loading a real gallery
  turned it on and eight of nine real users vanished at an unfamiliar merchant.
  Narrowing is now only the first tier — a miss widens to the whole gallery
  before anyone is turned away, and the audit row records which tier answered.
- **A terminal could say which shop it was.** `/api/verify/start` read
  `merchantId` from the request body, and the approval check added alongside
  merchant sign-up read the same field — so the gate was asking the caller
  which identity to check them against. A shop that had signed up and not been
  approved simply sent the kiosk's id instead and scanned customers anyway,
  learning the name of anyone who looked at its camera. The rule was already
  written down one file away, in `requireMerchant`: a merchant id from a
  request body is a value the caller chose, not an identity. The public route
  now takes no shop id at all and books to a server-side constant; a till uses
  an authenticated route and is booked to the shop in its token.

- **A face could take away the PIN that protects it.** Re-enrolling overwrote
  `pinHash` unconditionally — deliberately, because that was the way back for
  people who enrolled while a PIN was optional. Nobody had followed the
  consequence through: present somebody's live face, choose a new PIN, and the
  second factor the face was supposed to need is yours. Records now seal when
  their PIN is set, and a sealed one refuses the whole enrollment rather than
  just the PIN, so a stranger cannot even refresh the stored signature.
  Everything registered before this gets exactly one more pass through the old
  route and seals behind it.

- **The enrollment prompts were decorative.** "Turn your head slightly left"
  went out at `/enroll/start` and nothing ever looked at it again — capture
  checked sharpness, face count and anti-spoofing, and nothing about where the
  head was pointing. Five samples of one unmoving head passed as five angles,
  so the fused signature held one view recorded five times instead of the pose
  variety it exists for. Each sample is now checked against the prompt it is
  answering, and the refusal says which way it went wrong: "you did not move"
  and "you moved the wrong way" need different sentences.
- **And the pose check nearly shipped with the wrong rest position.** A new
  `head_pitch_ratio` measures the nose between forehead and chin, and the first
  version assumed it sits at 0.5 when level, as yaw does. A real face says
  otherwise — 0.5154 on yaw but **0.6041 on pitch** — because the nose is not
  halfway down the face. Against a fixed midpoint that face passed "chin down"
  without moving and needed three times the intended movement for "chin up".
  Proportions vary between people, so the fix is the one the liveness challenge
  already uses: the "look straight" sample is the baseline, and every later
  prompt is measured from it.

- **Blinks would have gone undetected over a network.** Thresholds were frame
  counts, which only mean anything at a fixed frame rate. At the 5-8fps a
  browser achieves, a 200ms blink spans one frame. They are milliseconds now.

## Deploying

`DEPLOY.md` walks through it. For collecting data from people over a few days,
a tunnel from your own machine (`cloudflared tunnel --url http://localhost:3000`)
is free and takes two minutes — the Node service serves the built kiosk, so one
tunnel exposes the whole app on one URL. For something that stays up without a
laptop, the root `Dockerfile` builds all three into one image.

**The live URL is slower than a laptop, and that is the free tier.** A free
container gets a slow, shared, thread-capped CPU, and all the ML runs on it. The
same 12-frame batch:

```
laptop, ML service warm          149 ms
deployed on Railway            ~1800 ms      about 12x slower
```

Most of that is CPU; some is the round trip to the server, which was not
separated out. Scans stay usable — a few seconds instead of under a second — but
any latency figure taken from the live URL describes a free CPU, not this
system. Railway was chosen because it is free; `DEPLOY.md` has the comparison
against Cloud Run and Oracle.

Two other things about that deployment were not obvious:

- **One replica, always.** Liveness sessions live in the Python process's
  memory, not in the database, and one verification is 20-30 separate requests
  carrying the same session id. A second replica means some of those frames
  land on a container that has never heard of that session — the scan dies
  partway through, intermittently, with nothing useful in the logs.
- **Cap the inference threads.** In a container, ONNX Runtime and OpenMP read
  the *host's* core count and start that many threads while the container is
  limited to one or two vCPU; they then spend more time contending than
  working. Frames were taking over fifteen seconds each until
  `OMP_NUM_THREADS=2` and `MKL_NUM_THREADS=2` were set. (An
  `ONNXRUNTIME_NUM_THREADS` variable is often suggested for this and does
  nothing — no such variable exists.)

The API and the ML service are deployed together on purpose. Every liveness
frame travels browser → Node → Python → back, so splitting them across hosts
adds a network hop to each of the 20-30 frames in one verification, and the
frame rate is what blink detection depends on.

## What each phase turned into

- **Phase 1** — detection, passive liveness, anti-spoofing, 1:N identification.
- **Phase 2** — a four-digit PIN, with a lockout after three refusals, and two
  ways back that are deliberately not the face: a forgotten password is reset
  with the registered name and the PIN through that same lockout, and a
  forgotten PIN is changed with the account password. A face that could reset
  either would make both decorative, which is the whole reason the PIN exists.
  The
  spoken challenge that was planned alongside it was **dropped**: voice cloning
  defeats speaker verification, and unlike the face side there is no mature
  liveness answer for it (see ASVspoof). Face plus PIN already satisfies a
  two-factor requirement with one dynamic factor, so the voice layer was an
  extra rather than a gap.
- **Phase 3** — Razorpay in test mode, wired to the auth result, producing a
  transaction record and a printable receipt.

## Merchants, and what signing up gets you

Anyone can open a shop account, and it grants nothing on its own: the terminal
it creates can sign in and read its own empty ledger, and that is all. Starting
a scan needs approval, which is a command rather than a screen:
`node src/scripts/seedMerchant.js --verify <email>`.

The split is not about money. Charging already needs the customer's own PIN, so
a hostile shop cannot take anything. What an unapproved terminal could do is
point a camera at a queue and be told everybody's name — which makes it a
privacy surface before it is a payment one, and that is what approval gates.

Every self-registered shop also gets a random suffix on its id
(`corner-store-a3f9c1`). The id is stamped on every transaction and sits in
every customer's `knownMerchants`, so it cannot be swapped later; deriving it
from the name alone would let the first person to sign up as "Corner Store"
take the id the real one would want.

## Not built, and why

- **Speaker verification.** Dropped for the reason above, not deferred.
- **Automated fraud detection.** Rule-based flagging over `VerificationLog` was
  built and then removed. Replayed over 290 real logs, the rules that fired at
  all were firing on our own testing — deliberate photo attacks, which they
  caught, and ordinary failed scans in bad light, which they did not distinguish
  from attacks. A rule whose true and false positives cannot be told apart at
  this volume is a number on a slide, not a control.
  `VerificationLog` still records everything those rules read, so the data is
  there when there is enough of it to mean something. That is the upgrade path,
  and it needs real volume rather than more code.
- **A trained anomaly model.** The same rows become labelled training data once
  there is real fraud to label. There is none, and training on invented fraud
  would be theatre.
- **Self-service password reset for merchants.** A customer can prove
  themselves with a PIN and a face. A shop account has neither, so anything
  automatic would come down to whoever controls the mailbox — and nothing here
  sends mail. The sign-in screen points at a human instead, and resets happen
  through `seedMerchant.js --reset-password`.

## Where this sits against Indian regulation

Not a compliance claim, and not a legal review. It runs in Razorpay **test
mode**, moves no real money, and holds data only from people who were asked in
person — so nothing here is under obligation yet. What follows is which design
decisions were made with the rules in mind, and what a real deployment would
still owe.

### DPDP Act 2023

Biometric data is personal data under the Act. Five of its duties have a
matching design decision, and it is worth naming which:

| the duty | what the system does |
|---|---|
| notice and consent | a consent screen before the camera opens, not a checkbox in a footer — it says "512 numbers, encrypted, no photo kept", which is checkable |
| purpose limitation | the embedding is used to identify at a till and for nothing else. Benchmark rows cannot be charged, by name, in two code paths |
| data minimisation | no phone number, no address, no raw image, ever. 1:N means nothing needs a contact detail to look someone up, and a field that does not exist cannot leak |
| right to erasure | `DELETE /api/user/me` removes the face record and the probe embeddings kept on failed attempts, and severs — rather than deletes — the payment history |
| security safeguards | AES-256-GCM with key versioning, scrypt for passwords and PINs, and no raw images at rest |

**What a real deployment would still owe**, and does not have: a named
grievance officer, a stated retention period (sessions expire on a TTL, but
enrolled embeddings are kept indefinitely), a breach-notification path to the
Data Protection Board, and consent records that survive somebody clearing
`localStorage`. These are process, not code, which is why they are listed
rather than half-built.

### Two-factor authentication

A payment here needs **two factors from two different categories**: the face
(inherence) and a four-digit PIN (knowledge). Neither works alone — the face
cannot authorise a charge, and the PIN is useless without being recognised
first.

That separation is enforced rather than assumed, which is why both recovery
routes deliberately avoid the face: a forgotten password is reset with the
registered name and the PIN, and a forgotten PIN is changed with the account
password. A face that could reset either would collapse the two factors into
one.

The PIN is four digits, which is only safe because the attempts run out — three
refusals and the record locks. That lockout is shared by every path that checks
a PIN, including password reset, so the reset route cannot be used to get around
it.

## Honest limits

- A well-made 3D mask defeats both liveness modes, and for different reasons:
  one with cut-out eyes can satisfy the challenge's EAR and gaze checks, and
  the anti-spoof models behind the passive mode were trained on print and
  replay rather than on masks. Defending against it needs depth or infrared,
  which a browser cannot reach.
- An attacker injecting frames below the camera driver bypasses liveness
  entirely. That needs hardware attestation.
- The anti-spoof models are sensitive to the camera they were trained on, by
  their own authors' admission. On the cameras used here genuine faces score
  0.572 and above while print and screen attacks top out at 0.482, but a new
  sensor has to be measured rather than assumed.
- A session the user simply abandons writes no audit row.
- The continuity check that confirms the face which finished liveness is the
  one being recognised was first set at 0.80 similarity and turned away 21% of
  genuine sessions; it now sits at 0.40, above every impostor score measured
  and below every genuine session measured. Both numbers are in `config.py`,
  because a threshold nobody measured is a guess with a decimal point in it.
