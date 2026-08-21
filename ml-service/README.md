# ML Service — face detection, liveness, 1:N identification

Phase 1 of the phone-less biometric payment system. This service does the ML
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
pytest                  # 49 tests
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

`/verify/match` takes the candidate pool in the request body, since the
database lives behind Node. At demo scale that is every enrolled user. In
production Node narrows it first — by merchant locality, recent activity, or
repeat-customer history — so the comparison count stays bounded as enrollment
grows. The service does not care how the pool was chosen.

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

## Known limits

Stated plainly, because the pitch is stronger for acknowledging them:

- A high-quality 3D mask with cut-out eyes could satisfy both EAR and gaze.
  Defending against it needs depth sensing.
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
| `liveness.py` | randomised challenge state machine |
| `recognition.py` | ArcFace embeddings, 1:N matching, enrollment fusion |
| `session_store.py` | TTL session state, best-frame selection |
| `schemas.py` | request/response contract with the Node layer |
| `app.py` | FastAPI endpoints |
| `tools/live_check.py` | live webcam signal viewer for threshold tuning |
