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
cd ml-service && pytest         # 90
cd backend && npm test          # 50
```

The liveness state machine is tested against synthetic landmark geometry, so
every spoof scenario — a held photo, a replayed blink, a head turned at rest —
runs without a camera.

## What has been measured

**Impostor separation.** Six different people from one photo, 15 impostor
pairs: highest 0.194, mean 0.034. One live session gave a genuine match at
0.896 against a runner-up of 0.083. The default `match_threshold` of 0.45 sits
in a wide gap, but that is a handful of samples — not yet a FAR/FRR claim.

**Blink thresholds across five people.** Open-eye EAR ranged 0.316 to 0.418, a
32% spread, while the ratio of blink floor to open eye held between 16% and
22%. That is why the blink threshold scales to each person's own measured open
eye rather than being a fixed number.

Every attempt is logged with both scores, the thresholds in force, and the full
liveness signals, so the FAR/FRR curves can be drawn from real attempts rather
than estimated.

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
