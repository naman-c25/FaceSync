# Deploying

Live at **https://facesync-production.up.railway.app**, on Railway.

Two different needs, two different answers:

- **Collecting faces from friends for a few days** — a tunnel from your laptop.
  Free, two minutes.
- **A link that stays up without the laptop** — a host. That is Railway here.

---

## What it needs

Measured on a real container doing real enrollments, not guessed:

| | |
|---|---|
| image size | ~3.5GB |
| memory, idle | 585MB |
| memory, after enrollments | 792MB |
| **memory to provision** | **2GB** |

1GB looks like it fits and does not — 792MB leaves 23% headroom, and two people
scanning at once eat it.

## Picking a host

| host | memory | cost | why / why not |
|---|---|---|---|
| **Railway** ← chosen | 8GB | free credit each month | **free**, deploys straight from the repo, HTTPS included, nothing to rebuild |
| Google Cloud Run | 2GB+ | free tier, card on file | scales to zero, but needs a card, and the 3.5GB image costs a little to store |
| Oracle Cloud | 24GB | free forever | most hardware, but ARM — the image needs rebuilding, and HTTPS is yours to set up |
| Render / Koyeb / Fly free | 512MB | free | **will not load the models** |

**Railway was chosen because it is free.** The monthly credit covers a demo, and
of the three it was the one that needed no image rebuild and no manual HTTPS.
Cloud Run and Oracle both work — they are written up below in case the credit
runs out.

Hugging Face Spaces was looked at and dropped: Docker Spaces are a paid tier.

---

## The free server is slower, and it shows

A free container gets a slow, shared, thread-capped CPU. All the ML runs on that
CPU, so **face scans take noticeably longer on the live URL than on a laptop.**

The same 12-frame batch, same code, same models:

```
laptop, ML service warm          149 ms
deployed on Railway            ~1800 ms       about 12x slower
```

Most of that gap is CPU. Some of it is the round trip to the server, which was
not separated out. There is no fix inside a free tier — more vCPU is the fix,
and that is the paid tier.

**It stays usable.** A scan is a few seconds instead of under a second. What it
does mean: any latency number taken from the live URL is a number about a free
CPU, not about the system.

### The thread setting that made it ten times worse

Before this was set, frames took **over fifteen seconds** each and the platform
answered 502.

In a container, ONNX Runtime and OpenMP read the *host's* core count and start
that many threads, while the container is limited to one or two vCPU. They then
spend more time contending than working. Cap them:

```
OMP_NUM_THREADS=2
MKL_NUM_THREADS=2
```

The first guess was memory — it was wrong. Memory sat flat at ~800MB right
through the failures. An `ONNXRUNTIME_NUM_THREADS` variable is widely suggested
for this too; it does not exist and does nothing.

### One replica, always

Liveness sessions live in the Python process's memory (`session_store.py`), not
in the database, and one verification is 20-30 separate requests carrying the
same session id. A second replica means some of those frames land on a container
that has never heard of that session — the scan dies partway through,
intermittently, with nothing useful in the logs.

Railway runs one replica by default. On Cloud Run it is `--max-instances 1`.

---

## Deploying to Railway

1. New project → Deploy from GitHub repo. It finds the root `Dockerfile`.
2. Set the variables below.
3. Generate a domain under Settings → Networking.

```
MONGODB_URI          mongodb+srv://...     Atlas, see below
ENCRYPTION_KEY       64 hex chars          the one already in backend/.env
OMP_NUM_THREADS      2
MKL_NUM_THREADS      2
RAZORPAY_KEY_ID      rzp_test_...          test mode
RAZORPAY_KEY_SECRET  ...
```

`PORT` is injected by the platform. Everything else has a default baked into the
Dockerfile.

**Three that usually need nothing, and one case where they do:**

| | default | when to change it |
|---|---|---|
| `TRUST_PROXY` | `1` | one proxy is what every host here uses. Raise it only if you put another in front — and never set it to trust every hop, or a caller can spoof `X-Forwarded-For` and pick which rate-limit bucket to spend |
| `RATE_LIMIT_ENABLED` | `true` | leave it. It is off only in `tests/test.env`, where every request comes from one address |
| `CORS_ORIGINS` | empty | empty is right when the Node service serves the frontend, which is how this deploys — every request is then same-origin. Set real origins, or `*`, only for a split deployment |

If `TRUST_PROXY` were wrong, the symptom is distinctive: everything works until
someone hits a limit, and then **everyone** is refused at once, because the whole
internet is being counted as the proxy's single address.

The first build is slow, because the image bakes in ~300MB of models. That is
deliberate: downloading them on first request would make the first visitor wait
for all of it, and on a link shared with friends that is most people.

### Both services in one image, on purpose

Every liveness frame travels browser → Node → Python → back. Splitting them
across two hosts adds a network hop to each of the 20-30 frames in a single
scan, and the frame rate is what blink detection depends on.

### What is pinned, and what floats

**Pinned:** every Python package (`requirements.txt`, 60 exact versions,
transitive ones included) and every npm package (both lockfiles, installed with
`npm ci`). These were unpinned until an unpinned resolution handed CI a newer
Starlette than the laptop had and the test client stopped importing — and the
deployed image builds from the same file, so an unpinned rebuild during a demo
week could change what ships with no commit behind it.

**Floating, deliberately:** the base images, `python:3.12-slim` and
`node:22-slim`. Pinning those by digest would make the build bit-for-bit
reproducible and stop OS security patches arriving — openssl and glibc included,
on a system that handles biometric data. It would also freeze whatever CVEs the
base carried on the day it was pinned, so a scanner would report *more* over
time, not fewer.

The risk floating leaves is a base image that changes out from under the build —
which is real here, since the image installs specific native libraries by name
(`libgl1`, `libegl1`) and Debian has renamed such packages between releases.
That risk is covered by the `image builds` job in CI: it builds this Dockerfile
on every push, so a broken base is caught before Railway deploys it rather than
after.

`.github/dependabot.yml` keeps the pinned halves from rotting. It deliberately
does **not** include the Docker ecosystem, because moving to Python 3.13 or Node
24 is a decision to make on purpose rather than to be nudged into weekly.

---

## Alternatives

### Google Cloud Run

The free tier is 2M requests, 360,000 GiB-seconds of memory and 180,000
vCPU-seconds a month. Those two run out at different times, so the smaller one
is the real budget:

| at `--cpu 2 --memory 2Gi` | | |
|---|---|---|
| memory | 360,000 ÷ 2 GiB | 50 hours |
| **vCPU** | **180,000 ÷ 2** | **25 hours** ← binds first |

25 hours of *request processing*, not of being deployed — it scales to zero and
idle costs nothing. One verification works out to roughly five seconds of
compute, which puts the tier somewhere north of 15,000 verifications a month.

```bash
gcloud run deploy facepay \
  --source . --region asia-south1 \
  --memory 2Gi --cpu 2 --max-instances 1 --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars "PORT=8080,OMP_NUM_THREADS=2,MKL_NUM_THREADS=2" \
  --set-secrets "ENCRYPTION_KEY=facepay-key:latest,MONGODB_URI=facepay-mongo:latest"
```

```bash
echo -n "<64 hex chars>" | gcloud secrets create facepay-key --data-file=-
echo -n "<atlas string>" | gcloud secrets create facepay-mongo --data-file=-
```

`asia-south1` is Mumbai — worth picking, since every frame makes a round trip
and the region is most of that latency.

Two things here are not free: a card must be on file, and the 3.5GB image
against Artifact Registry's 0.5GB of free storage costs a few rupees a month.

Scaling to zero means the first request after an idle period waits out a 30-60
second cold start with an image this size. Open it yourself before sharing it.

### Oracle Cloud Always Free

The most hardware of the three, free with no expiry — but the free shapes are
ARM (Ampere). The image is built for x86, so it needs rebuilding on an ARM
machine or through buildx, and HTTPS is yours to arrange (Caddy or nginx with
Let's Encrypt). More setup than the other two. Not chosen for that reason, not
a technical one.

---

## The tunnel route, for collecting data

The Node service serves the built kiosk, so one tunnel to one port exposes the
whole app — no CORS, no second URL, no config change.

```bash
cd frontend && npm run build:serve   # once, and after any frontend change

cd ml-service && .venv/Scripts/activate && python app.py
cd backend && npm start

cloudflared tunnel --url http://localhost:3000
```

It prints an `https://something.trycloudflare.com` URL. HTTPS is included, which
the camera requires. `ngrok http 3000` works the same way.

The link dies when the laptop sleeps and the URL changes on restart. Nothing is
lost — the data is in MongoDB either way. Scans are fast here, because they run
on your CPU rather than a free one.

---

## MongoDB

The tunnel route can keep using local MongoDB. A real host needs Atlas.

1. Free **M0** cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. **Database Access** → a user with a long random password.
3. **Network Access** → `0.0.0.0/0`. No host publishes fixed egress IPs, so
   there is nothing narrower to allow — which makes that password the only thing
   in front of the database.
4. **Connect → Drivers**, and append the database name:

```
mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/facepay?retryWrites=true&w=majority
```

## The encryption key

```bash
cd backend && npm run keygen
```

**Reuse the one already in `backend/.env`.** A new key makes every existing
registration unreadable and everyone has to enrol again. It is not recoverable
and must never be committed.

---

## Before sharing the link

- **Open it yourself first.** A cold start is otherwise the first thing a
  visitor sees.
- **Register yourself first.** Verification compares a face against everyone
  enrolled; an empty database gives the first person `no_match` and they
  conclude it is broken.
- **Say something about consent.** People are handing biometric data to a
  student project. The consent screen is honest about what is kept, but a
  message beforehand goes further than a checkbox.
- **Ask for a few tries each, in different light.** One attempt per person is
  almost no evidence.

## Checking on the data

```bash
cd backend
npm run users                         # who is enrolled, and their scan history
node src/scripts/dedupe.js            # duplicate registrations, dry run
node src/scripts/dedupe.js --apply    # remove them
npm run fraud:replay -- --sweep       # every rule over the whole log
```

Prefix with `MONGODB_URI=...` to run against a deployed database.

## When something is wrong

**Scans take a few seconds** — expected on the free tier, see above. If they
take *fifteen* seconds, the thread caps are missing.

**502 from the platform** — almost always the frame request timing out behind
the ML call, not memory.

**`/health` returns 503 with `models_loaded: false`** — Python is running but
its models did not load. In a container this is nearly always a missing native
library: MediaPipe `dlopen()`s libEGL and libGLESv2 lazily, so the image builds
and the service starts before anything notices.

```bash
LIB=/usr/local/lib/python3.12/site-packages/mediapipe/tasks/c/libmediapipe.so
docker exec <container> ldd "$LIB" | grep "not found"
```

**`mlService.reachable: false`** — Python is not running at all, or the backend
is pointed at the wrong `ML_SERVICE_URL`.

**Everything returns `no_match`** — nobody is enrolled, or you are looking at a
different database than you think.

**Everything returns `ambiguous`** — someone is enrolled twice. Two copies of one
face sit inside the match margin of each other, so neither can be told from the
other. Enrollment collapses repeats now, so this only affects older records.

**`liveness_failed` constantly** — usually light. A backlit face defeats it. It
is the largest single failure kind in the log, at 26% of all attempts.

**A shop signs in but cannot scan** — it has not been approved yet. Approve it at
`/fraud`, or with `seedMerchant.js --verify <email>`.
