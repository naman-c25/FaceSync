# FaceSync

Pay at a shop without a phone, a card, or an app. Walk up, and the camera works
out who you are.

A prototype for the Razorpay hackathon, and it runs end to end: face detection,
passive liveness, anti-spoofing, 1:N identification, a four-digit PIN, a
Razorpay test-mode charge, a printable receipt, and rule-based fraud flagging
over the audit trail.

Live at **https://facesync-production.up.railway.app** — kiosk at `/`, merchant
till at `/till`, customer portal at `/account`, fraud review at `/fraud`.

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
frontend/     React — four entry points, chosen by path
```

Each has its own README with the detail. Short version:

- **ml-service** does the ML and nothing else. No database, no keys, no user
  records.
- **backend** owns all of that and calls the ML service with frames, then with
  a candidate pool to match against.
- **frontend** is four separate apps sharing one stylesheet: the kiosk (`/`),
  the merchant till (`/till`), the customer portal (`/account`) and fraud
  review (`/fraud`). They are split by path rather than folded together,
  because nothing customer-facing should carry code that charges money, and
  now also nothing should carry code that reads every terminal's traffic.

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
cd ml-service && pytest         # 116
cd backend && npm test          # 74
```

The liveness state machine is tested against synthetic landmark geometry, so
every spoof scenario — a held photo, a replayed blink, a head turned at rest —
runs without a camera.

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
actual code path, and the nine real enrolled users measured against them
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
accuracy and not for speed: the search was never the slow part. Approximate
search would in fact make things worse here, because the margin rule depends on
knowing the true runner-up, and an index that misses it reports a wider margin
than really exists — turning an `ambiguous` into a confident answer.

### Liveness

**Blink thresholds across five people.** Open-eye EAR ranged 0.316 to 0.418, a
32% spread, while the ratio of blink floor to open eye held between 16% and
22%. That is why the blink threshold scales to each person's own measured open
eye rather than being a fixed number.

Every attempt is logged with both scores, the thresholds in force, and the full
liveness signals, so these curves are drawn from real attempts rather than
estimated.

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

That is also why the kiosk's framing oval is 44% of the frame height rather
than the 63% it started at. A face filling the frame starves the models.

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
- **Blinks would have gone undetected over a network.** Thresholds were frame
  counts, which only mean anything at a fixed frame rate. At the 5-8fps a
  browser achieves, a 200ms blink spans one frame. They are milliseconds now.

## Deploying

`DEPLOY.md` walks through it. For collecting data from people over a few days,
a tunnel from your own machine (`cloudflared tunnel --url http://localhost:3000`)
is free and takes two minutes — the Node service serves the built kiosk, so one
tunnel exposes the whole app on one URL. For something that stays up without a
laptop, the root `Dockerfile` builds all three into one image.

It currently runs on Railway, and two things about that were not obvious:

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
- **Phase 2** — a four-digit PIN, with a lockout after three refusals. The
  spoken challenge that was planned alongside it was **dropped**: voice cloning
  defeats speaker verification, and unlike the face side there is no mature
  liveness answer for it (see ASVspoof). Face plus PIN already satisfies a
  two-factor requirement with one dynamic factor, so the voice layer was an
  extra rather than a gap.
- **Phase 3** — Razorpay in test mode, wired to the auth result, producing a
  transaction record and a printable receipt.
- **Phase 4** — rule-based flagging over `VerificationLog`, reviewed at
  `/fraud` behind an admin account. Not a trained model, deliberately: there is
  no real fraud data to train on, and training on invented fraud would be
  theatre. `npm run fraud:replay -- --sweep` re-runs every rule over the whole
  log and prints how often each would fire.

## Not built, and why

- **Speaker verification.** Dropped for the reason above, not deferred.
- **Two of the four fraud rules.** "Many distinct people at one terminal" and
  "a spike in ambiguous results" were specified and left unbuilt. Replayed over
  205 real logs they fire zero times at every threshold tried — there are
  thirteen enrolled users and not one `ambiguous` outcome in the whole file.
  Shipping them so the count reads four would be the same dishonesty as the
  trained-model claim above.
- **A trained anomaly model.** The same `VerificationLog` rows become labelled
  training data once there is real volume. That is the upgrade path, not a
  missing piece.

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
