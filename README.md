# FacePay

Pay at a shop without a phone, a card, or an app. Walk up, and the camera works
out who you are.

A prototype for the Razorpay hackathon. Phase 1 — face detection, liveness, and
1:N identification — is built and tested.

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
frontend/     React — the kiosk, mobile-first
```

Each has its own README with the detail. Short version:

- **ml-service** does the ML and nothing else. No database, no keys, no user
  records.
- **backend** owns all of that and calls the ML service with frames, then with
  a candidate pool to match against.
- **frontend** is the camera and the prompts.

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
photography, heavily skewed toward white American men, and FacePay is for Indian
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
base64 decode of the gallery           16.9   ms
fetch + decrypt + ship from MongoDB  1500-2800 ms   <- 5.35MB per payment
```

The matching is free. What costs is reading 2,009 encrypted rows out of MongoDB
and shipping them to the recognition service on every single payment. At 10,000
enrolled that is roughly 27MB and ten seconds, which is not a payment terminal.

This is the honest answer to "do we need a vector database". Not for accuracy,
and not yet: MongoDB is fine to a few hundred. The reason to move is that the
vectors should live where the search happens instead of crossing the network
once per transaction.

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
service watches a face for about a second and a half and accepts it. What it
actually checks is a face present throughout, one face clearly dominant in
frame, a minimum number of frames over a minimum duration, and frames that are
not byte-identical to each other.

That last check catches a static image fed straight into the pipeline. **It
does not catch a photograph held up to the camera**, and this should not be
described as though it does. Measured on this pipeline, a still photograph
passes every per-frame gate there is — sharpness 51.9 against a floor of 45,
detection score 0.865 against 0.60, landmarks found, a usable 512-dimension
embedding produced. Nothing outside the challenge objects to a photograph.

So in passive mode the honest statement is: **the face identifies, and the PIN
authorises.** An attacker holding your photograph gets as far as being
recognised as you and is then stopped by a four-digit secret they do not have.
That is one factor doing the work of two, and it is a deliberate trade of
security for speed at the till rather than a claim about spoof resistance.

Turning the challenge back on is one environment variable, and its tests and
measurements are all still in the tree.

### What would close the gap

Passive presentation attack detection — texture and moiré analysis for screens,
and the fact that a real face is a three-dimensional object while a photograph
is a plane, so the landmark configuration of a real face deforms non-rigidly as
the head moves while a photograph's deforms as a homography.

The honest difficulty is not building it, it is validating it. A detector
trained on one room, one camera and one printer learns those conditions rather
than the attack, which is why published cross-dataset error rates are an order
of magnitude worse than within-dataset ones. A weak passive detector is worse
than none, because it replaces a known limit with an unknown one.

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
laptop, the root `Dockerfile` builds all three into one image; Google Cloud Run
is the closest thing to a free tier that has enough memory to load the models.

The API and the ML service are deployed together on purpose. Every liveness
frame travels browser → Node → Python → back, so splitting them across hosts
adds a network hop to each of the 20-30 frames in one verification, and the
frame rate is what blink detection depends on.

## Not built yet

- **Phase 2** — dial PIN and the merchant's spoken random challenge (ASR plus
  speaker verification). `ambiguous` results are where the second factor earns
  its place.
- **Phase 3** — Razorpay test-mode payment wired to the auth result.
- **Phase 4** — fraud and anomaly detection over `VerificationLog`. The schema
  is already carrying what it needs, including the probe embedding of failed
  attempts, which is what makes it possible to spot the same unidentified face
  across merchants.

## Honest limits

- A high-quality 3D mask with cut-out eyes could satisfy both EAR and gaze.
  Defending against it needs depth sensing.
- An attacker injecting frames below the camera driver bypasses liveness
  entirely. That needs hardware attestation.
- Locality narrowing trades recall for speed: someone who established a
  locality in one city and pays in another falls outside the narrowed pool. A
  production system answers that with a tiered search — query narrow, widen on
  a miss.
- A session the user simply abandons writes no audit row.
