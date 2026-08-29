# ML Service — face detection, liveness, 1:N identification

The ML half of the phone-less biometric payment system. This service does the ML
and nothing else: it holds no database connection, no encryption keys and no
user records. The Node layer owns all of that and calls in here with frames,
then with a candidate pool to match against.

## Setup

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows
pip install -r requirements.txt
python setup_models.py          # ~300MB, once
python app.py                   # serves on 127.0.0.1:8001
```

Interactive API docs at `http://127.0.0.1:8001/docs`.

```bash
pytest                  # 174 tests
pytest -m "not slow"    # skip the ones that load real models (~1s)
```

## Tune the thresholds before you trust anything

The defaults in `config.py` are starting points from the literature, not
measurements of your face under your lighting. Eye shape varies enough between
people that a default EAR threshold can reject someone who is blinking
perfectly normally.

```bash
python tools/live_check.py
```

This shows every signal live off your webcam. It spends a second learning your
rest position, then reports everything as movement away from it — the same way
liveness scores it. Blink deliberately, turn your head both ways, then move
just your eyes. Quitting prints thresholds derived from what you actually did.

Any setting can also be overridden by environment variable without editing the
file, which is what you want when sweeping values:

```bash
FACEPAY_MATCH_THRESHOLD=0.52 FACEPAY_EAR_THRESHOLD=0.19 python app.py
```

### Measured EAR across five people

| open eye | blink floor | floor as % of open |
|---|---|---|
| 0.418 | 0.086 | 21% |
| 0.316 | 0.051 | 16% |
| 0.408 | 0.067 | 16% |
| 0.342 | 0.074 | 22% |
| 0.326 | 0.053 | 16% |

Open-eye EAR spans 0.316 to 0.418 — a 32% spread — while the *ratio* of blink
floor to open eye holds between 16% and 22%. That is why blinks are scored
against `ear_closed_fraction` of each person's own measured open eye rather
than a fixed number: the ratio transfers between people, the absolute value
does not.

Being precise about what that buys: across these five, a fixed threshold of
0.20 would have given the same worst-case margin (0.114). What the relative
threshold improves is the *balance* — margin imbalance drops from 0.102 to
0.046, so it stops favouring wide-eyed subjects. The bigger gain is outside the
sampled range: someone with an open eye of 0.25 gets 0.05 of headroom under a
fixed 0.20 and 0.11 under the relative rule.

These five subjects are baked into `test_liveness.py` as parametrised cases, so
a future change to the blink logic has to keep working for all of them.

### A first calibration data point

Running the pipeline over the six-person group photo bundled with InsightFace
gives 15 impostor pairs — different people compared against each other:

| | cosine similarity |
|---|---|
| highest impostor pair | 0.194 |
| mean impostor pair | 0.034 |
| lowest impostor pair | -0.058 |

So different people land near zero and the default `match_threshold` of 0.45
sits well clear of the highest impostor score seen. That is 15 pairs from one
photo, not a calibration — collect genuine-vs-impostor scores from your own
test captures before quoting a FAR/FRR number to anyone.

## Flow

```
enrollment          /enroll/start → /enroll/capture ×5-8 → /enroll/finalize
                    returns one fused 512-d embedding for Node to encrypt

verification        /verify/start → /verify/frame ×N → /verify/match
                    liveness runs first; matching is refused until it passes
```

`/verify/match` takes the candidate pool in the request body, since the database
lives behind Node. Node narrows it first — by merchant locality, recent activity
and repeat-customer history — and widens to the whole gallery on a miss, so a
narrowed pool can never be the reason somebody is turned away. The service does
not care how the pool was chosen.

Frames are sent one at a time, each after the previous response, with no timer.
Every threshold that could have been a frame count is measured in milliseconds
instead, so the same code behaves identically at the 5-8fps a browser achieves
over a network and at 30fps on a desk. Blink thresholds were frame counts once;
at 5fps a 200ms blink spans a single frame and would have gone undetected.

## The two-condition match rule

Because this is 1:N identification rather than 1:1 verification, a plain
threshold check is not enough. Both conditions must hold:

1. **Top score clears `match_threshold`** — the same test a 1:1 system applies.
2. **Top score beats the runner-up by `match_margin`** — otherwise the result
   is `ambiguous`, not a match.

The second one is the one that gets forgotten. In 1:N, every extra enrolled
user is another chance to be confused with someone else: system-level false
match rate scales roughly as `N × per-comparison FMR`. If the top two
candidates are near-tied, the system genuinely does not know which of them is
standing at the kiosk, and returning the higher score would be a coin flip
dressed up as a decision. `ambiguous` is where the second factor earns its
place — it disambiguates, and never identifies on its own.

## Two liveness modes

`FACEPAY_LIVENESS_MODE` switches between them, and which one is on changes what
the face factor is worth.

**`challenge`** — a randomised prompt chosen per session with `secrets`: blink
twice, look left, look right. A printed photograph cannot perform an action it
has not been shown, so this is genuine presentation attack detection against
print, and against replay to the extent that a recording cannot answer a prompt
it has never seen.

Measured over 86 real attempts: median **8.0 seconds** with two steps, and one
attempt in five failed. One step roughly halves that.

**`passive`** — what the demo runs. No prompt: the service watches a face for
about a second and a half, then hands the best frame to the anti-spoof models.
Faster and easier, and it leans entirely on those models rather than on a
challenge nothing can fake.

The challenge is one environment variable away, and its tests and measurements
are all still in the tree.

## Presentation attack detection

Two MiniFASNets from
[minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing)
(Apache-2.0), converted to ONNX. 3.4MB together, on the ONNX Runtime already
loaded for ArcFace. They classify three ways — paper photo, real face, screen
photo — and run once per session, on the frame the payment rests on. `pad.py`.

Against the reference project's own labelled images, through this pipeline:

```
image_F1  screen   crop 2.47   real 0.181   BLOCKED
image_F2  screen   crop 2.05   real 0.002   BLOCKED
image_F3  screen   crop 2.62   real 0.144   BLOCKED
image_F5  paper    crop 1.90   real 0.000   BLOCKED
image_T1  live     crop 2.61   real 1.000   allowed
image_T2  live     crop 1.95   real 0.999   allowed
```

Two others never reach the models: one has no detectable face, and one holds two
faces of comparable size, which the dominance rule refuses first.

**Three things that had to be right:**

- **Threshold on the real-class score, not `argmax`.** A three-way argmax makes
  "slightly more real than paper" a pass. The gate is the real score itself.
- **Raw BGR in, no CLAHE.** The lighting normalisation that helps recognition
  destroys the texture signal these models read.
- **The crop is the whole thing.** The numbers in the model filenames are
  bounding-box expansion factors, and each model was trained on a crop of its
  own size. Handed something tighter they still answer, still confidently, and
  the answer is worth nothing. Every reference sample clamps to between 1.90 and
  2.62 and is classified correctly; the one sample the models get wrong is the
  only one whose crop collapses to 1.21. So there is a floor, and below it the
  verdict is *no verdict* rather than a bad one.

That is also why the kiosk's framing oval is 44% of frame height rather than the
63% it started at. A face filling the frame starves the models.

**What this does not claim.** The threshold has not been calibrated on the
cameras it will run on, and the model authors state the limitation themselves:
"limited robustness to camera model type and usage scenarios". Measured across a
domain shift — 120 LFW captures of real people — **9.2% were called attacks**.
`tools/silent_pad.py --data` is how to re-measure on real captures before the
threshold moves. On the cameras used here genuine faces score 0.572 and above
while print and screen attacks top out at 0.482, but a new sensor has to be
measured rather than assumed.

## The continuity check

Liveness passes on one frame and recognition runs on another, so something has
to confirm they are the same person — otherwise a live face could satisfy
liveness and a photo could be swapped in for the match. An early frame and a
late frame are compared with ArcFace cosine.

**The threshold was set too high and rejected real users.** At 0.80 it turned
away 6 of 28 genuine sessions — 21%. The comment in `config.py` claiming a swap
"drops into impostor range, nothing in between" was simply wrong. Measured, real
sessions span **0.481 to 0.984**, and the highest impostor score measured
anywhere is **0.2233**. It sits at 0.40 now: above every impostor score seen and
below every genuine session seen. Both numbers are in `config.py`, because a
threshold nobody measured is a guess with a decimal point in it.

## Two passive checks that were measured and abandoned

Built, measured, rejected — before reaching for a trained model. Both tools are
kept, because a measured negative is a result.

**Planar versus 3D** (`tools/planar_check.py`). A real face is a solid and a
photograph is a plane, so align two views with the best-fitting homography and a
real face should leave a residual a flat picture cannot. It does — but to turn
away 97% of photographs it refuses one real customer in ten. The test also
flattered it: its "real" pairs were press photographs years apart, not someone
holding still for a second at a kiosk.

**Gaze and eyelid micromotion** (`tools/micromotion_check.py`). A photograph's
gaze is fixed; a living eye microsaccades several times a second. Real passive
scans move gaze by 0.032-0.168 over their window. A photograph in an unsteady
hand moves it by a median of 0.038 — 65% of held photographs reach the floor no
live scan fell below.

Both measured *geometry*, and on a moving image landmark noise is the same size
as the biological signal. The MiniFASNets look at pixels instead, which is a
different signal and not the one landmark noise destroys.

## Bucketing the gallery, and why it cannot help

The obvious way to make 1:N faster is what every vector index does: cluster the
gallery, search only the promising clusters. Approximate versions are off the
table here — the margin rule needs the true runner-up, and an index that misses
it reports a *wider* margin than really exists, turning an `ambiguous` into a
confident wrong name.

So `tools/bucketed_gallery.py` implements the exact version. Cluster the
embeddings and bound each bucket by the triangle inequality: nothing inside can
score higher than `centre · probe + radius`. Visit buckets in descending order of
that ceiling, stop when it drops below the fifth-best score so far — provably
safe, because a bucket is skipped only once it *cannot* hold a better answer.

It works, and it is useless. `tools/bucket_check.py` over 5,486 real embeddings:

```
                   compared        time      vs full scan
N = 2,017     2,017 of 2,017     0.251 ms      3.6x slower
N = 5,000     5,000 of 5,000     0.674 ms      7.7x slower
full scan                   0.070 / 0.088 ms
```

The top five come back identical on every probe, and **not one bucket was ever
pruned**. In 512 dimensions a cluster of faces has a radius close to the √2 that
separates two arbitrary unit vectors, while `centre · probe` spans a much
narrower range — so every ceiling sits above every achievable score and the skip
test never fires. That is the curse of dimensionality, not a tuning problem, and
it is exactly why production indexes are approximate.

Both tools are kept and unused, as the evidence for that conclusion. Once pruning
is gone, `matrix @ probe` is already the best available: BLAS goes from 2,017
rows to 5,000 for 1.3x the time, so a hundred thousand would still be about two
milliseconds. The search was never the slow part — see `backend/README.md` for
what actually was.

## Choices that differ from the Phase 1 design doc

**InsightFace instead of DeepFace.** TensorFlow publishes no wheel for Python
3.14, and DeepFace depends on it. InsightFace runs the same ArcFace
architecture (`w600k_r50`, 512-d) on ONNX Runtime — no TensorFlow tree, and
models load in about 3 seconds. Only the `detection` and `recognition` modules
are loaded; buffalo_l also ships gender/age and two dense landmark models that
nothing here uses and that would otherwise run on every detected face.

**MediaPipe Tasks API instead of `mp.solutions`.** MediaPipe 1.0 removed the
legacy solutions API. The Tasks API needs a model bundle on disk, which
`setup_models.py` fetches.

**No separate alignment step.** The design doc lists face alignment under
preprocessing. InsightFace already applies a five-point similarity transform
before embedding, so adding our own would warp the face twice and make matching
worse. Preprocessing here is lighting normalisation (CLAHE) and quality gating
— the parts InsightFace does not do.

**Liveness state lives in this service's memory.** The doc puts session state
in Redis behind Node, but liveness is inherently frame-to-frame and the state
machine needs somewhere to live. `session_store.py` is a narrow enough
interface that moving it to Redis later touches only that file.

## Design notes worth keeping

**Liveness runs before recognition.** Per frame, only MediaPipe runs (~5-20ms).
ArcFace runs once, after liveness passes. A spoof attempt never reaches the
expensive stage.

**A look step scores movement, not position.** This is a security property
rather than a refinement. People hold their heads at all sorts of resting
angles, so any absolute threshold loose enough to accept them is also satisfied
by a still photo of someone whose head happens to be turned that way — the
photo sits permanently past the threshold. Each step captures a baseline over
its first few frames and requires the signal to move away from it, which a
fixed pose cannot do. An API test caught exactly this: a cropped face from a
group photo passed a look step until the check became relative.

**Liveness and recognition need different frame quality.** Recognition needs a
sharp frame; liveness needs landmarks, and MediaPipe finds those far below the
embedding threshold. Measured on one face: sharpness 51.8 still gave EAR 0.257
and sharpness 10.1 gave 0.219, against 0.271 unblurred.

Applying the embedding threshold (`min_sharpness`, 45) to liveness frames was a
false-rejection bug found in a real webcam session. Turning to follow a "look
right" prompt motion-blurs the frames mid-turn; every one was discarded before
detection ran, and the state machine read that run as the face having left. A
user doing exactly what was asked failed with `face_lost` — which is a false
rejection, and lands directly in the FRR being measured.

Liveness now uses `min_sharpness_liveness` (8), low enough for motion blur and
high enough to stop landmark noise inventing blinks. The sharp frame is still
required where it matters: the best frame of a session is re-checked against
`min_sharpness` before it becomes the probe.

**EAR is only read on a roughly frontal face.** EAR divides eyelid height by
the eye's corner-to-corner width, and that width foreshortens as the head turns
while the height barely does. So a turning head drives EAR wherever the
geometry takes it, with no eyelid movement involved — a live webcam session
recorded an "open eye" at 1.414 and a floor at 0.028 purely from head rotation.
Feeding those swings to the blink counter meant a challenge could be passed by
turning the head back and forth without ever blinking. Frames below
`min_frontality_for_blink` are now skipped for blink purposes, and skipped when
logging EAR too, so the audit trail cannot fill with impossible values.

**Eyes or head, either one.** Told to "look left", some people swivel their
eyes and others turn their head — and a head turn keeps the iris centred
between the eye corners, so the gaze ratio barely moves. Scoring only eye
movement would reject customers who did exactly what was asked, so
`head_yaw` (nose position between the face edges) is accepted as an
alternative.

**The matched frame is not the frame liveness finished on.** Liveness completes
on whichever frame satisfies the last action — very likely one where the user
is mid-blink or looking hard to one side, because that is what the challenge
just asked for. Embedding that frame would be the worst available choice. Every
frame is scored as it arrives (`session_store.frame_quality_score`) and the
best one is held back for recognition.

**One session, one identification attempt.** `/verify/match` discards the
session afterwards. Otherwise a caller could retry the same probe against
different thresholds until something matched, which would make the margin rule
a formality.

**Enrollment rejects freely.** The user is standing right there, so asking for
another frame costs a second — whereas a bad sample averaged into the stored
identity degrades every future match. Samples that disagree with the group are
dropped before fusion, which catches the frame that accidentally caught a
bystander.

**Everything needed for FAR/FRR is in the response.** `MatchResponse` carries
the runner-up score and the ranked candidate list, not just the winner. Without
both scores there is no way to tell a genuine rejection from a badly-set
threshold after the fact.

## Running it on a free server

Everything here is CPU inference, so the CPU it gets is the latency. On a free
container that CPU is slow, shared and thread-capped:

```
laptop, warm                     149 ms      12-frame batch
deployed on Railway            ~1800 ms      same batch, about 12x slower
```

**Cap the thread counts in a container.** ONNX Runtime and OpenMP read the
*host's* core count and start that many threads while the container has one or
two vCPU, then spend more time contending than working. Frames were taking over
fifteen seconds each until `OMP_NUM_THREADS=2` and `MKL_NUM_THREADS=2` were set.
An `ONNXRUNTIME_NUM_THREADS` variable is often suggested for this; it does not
exist.

**One process only.** Liveness state lives in this service's memory
(`session_store.py`), and one verification is 20-30 requests carrying the same
session id. A second replica means some frames land on a process that has never
heard of that session.

## Known limits

Stated plainly, because the pitch is stronger for acknowledging them:

- A high-quality 3D mask defeats both modes, for different reasons: one with
  cut-out eyes can satisfy the challenge's EAR and gaze checks, and the
  MiniFASNets were trained on print and replay rather than on masks. Defending
  against it needs depth or infrared, which a browser cannot reach.
- **The PAD threshold is not calibrated for the cameras it runs on.** 9.2% of
  real faces were called attacks across a domain shift. This is the largest open
  item here.
- An attacker who injects frames below the camera driver bypasses this layer
  entirely. That needs hardware attestation.
- `head_motion_px` is recorded but not enforced. A hand holding a printed photo
  shakes enough to clear any threshold worth setting, so it is evidence for
  analysis rather than a gate that would give false confidence.
- Randomised challenges are what defeat video replay. If the challenge pool
  ever shrinks to one action, that defence is gone.

## Files

| | |
|---|---|
| `config.py` | every tunable number, env-overridable |
| `preprocessing.py` | CLAHE lighting normalisation, quality gates |
| `face_detection.py` | MediaPipe Face Mesh → EAR and gaze |
| `liveness.py` | challenge and passive state machines |
| `pad.py` | the two MiniFASNets — presentation attack detection |
| `recognition.py` | ArcFace embeddings, 1:N matching, enrollment fusion |
| `session_store.py` | TTL session state, best-frame selection |
| `schemas.py` | request/response contract with the Node layer |
| `app.py` | FastAPI endpoints |
| `setup_models.py` | fetch buffalo_l and the MediaPipe bundle (~300MB) |
| `setup_pad_models.py` | fetch the anti-spoof pack (3.4MB) |

**Tools.** Everything here is a measurement instrument, not part of the running
service.

| | |
|---|---|
| `live_check.py` | live webcam signal viewer, for threshold tuning |
| `kiosk_demo.py` | drives the whole API from a webcam, no browser |
| `embed_dataset.py` | turn an image dataset into a gallery |
| `benchmark_1n.py` | the 1:N measurement — calls `recognition.identify` itself |
| `silent_pad.py` | run the shipped anti-spoof models over labelled images |
| `collect_pad.py` | capture real attack/live samples — the calibration set that does not exist yet |
| `train_pad.py` | a hand-built alternative PAD: LBP on chroma channels, SVM. Written but **never run** — it needs `benchmark-data/pad`, which `collect_pad.py` has not been used to fill. Its value is the evaluation protocol it insists on: leave-one-person-out, leave-one-condition-out, leave-one-camera-out |
| `bucketed_gallery.py`, `bucket_check.py` | the bucketing negative above. Kept unused, as the evidence |
| `planar_check.py`, `micromotion_check.py` | the two abandoned checks above. Same reason |
| `landmarks_vs_arcface.py` | measures whether 478 MediaPipe landmarks can identify anyone, so that running two face models is a measured decision rather than an assertion |
