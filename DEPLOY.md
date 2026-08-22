# Getting a link you can share

There are two different problems here, and they want different answers.

**Collecting data from friends over the next few days** — a tunnel from your own
machine. Free, works in two minutes, and everything already runs there.

**A link that stays up without your laptop** — a real host. Costs something, or
costs setup effort.

Start with the tunnel. Move to a host only when you actually need one.

> **Correction:** an earlier version of this file recommended Hugging Face
> Spaces. Docker Spaces are a paid tier, so that route is not free.

---

## The tunnel route

The Node service serves the built kiosk, so one tunnel to one port exposes the
whole app — no CORS, no second URL, no config changes.

```bash
# 1. Build the kiosk into the API service (once, and after any frontend change)
cd frontend && npm run build:serve

# 2. Start both services, in two terminals
cd ml-service && .venv/Scripts/activate && python app.py
cd backend && npm start

# 3. Open a tunnel — you already have both of these installed
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints an `https://something-random.trycloudflare.com` URL.
That is the link. HTTPS is included, which the camera requires.

`ngrok http 3000` works the same way if you prefer it.

**What this costs you:** the link dies when your laptop sleeps, and the URL
changes each time you restart the tunnel. For a few days of collecting faces
from people you can message a new link to, neither matters much. Nothing gets
lost — the data is in MongoDB either way.

Keep the laptop plugged in and stop it from sleeping while people are using it.

---

## When you need it always-on

The ML service is the whole constraint: roughly a gigabyte of models in memory.
That rules out most free tiers, which cap at 512MB.

| host | memory | cost | notes |
|---|---|---|---|
| **Google Cloud Run** | 2GB | free tier covers a demo | scales to zero, HTTPS included, needs a card on file |
| Railway | 8GB | $5 credit/month | easiest deploy of the three |
| Oracle Cloud | 24GB | free forever | ARM, and you set up HTTPS yourself |
| Render / Koyeb / Fly free | 512MB | free | **will not load the models** |

### Google Cloud Run

Closest to a free lunch that actually works. The free tier is 2M requests and
180,000 vCPU-seconds a month, which a demo does not come near. A card is
required, but nothing is charged inside those limits.

```bash
# install the gcloud CLI first: cloud.google.com/sdk
gcloud run deploy facepay \
  --source . \
  --region asia-south1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars "PORT=8080" \
  --set-secrets "ENCRYPTION_KEY=facepay-key:latest,MONGODB_URI=facepay-mongo:latest"
```

`asia-south1` is Mumbai — worth picking, since every liveness frame makes a
round trip and the region is most of that latency.

Store the two secrets first:

```bash
echo -n "<your 64 hex chars>" | gcloud secrets create facepay-key --data-file=-
echo -n "<your atlas string>" | gcloud secrets create facepay-mongo --data-file=-
```

Cloud Run scales to zero, so the first request after an idle period waits out a
cold start — 30-60 seconds with an image this size. Open it yourself before
sharing it.

---

## MongoDB

The tunnel route can keep using your local MongoDB. A real host needs Atlas.

1. Free **M0** cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. **Database Access** → add a user with a long random password.
3. **Network Access** → `0.0.0.0/0`. No host publishes fixed egress IPs, so
   there is nothing narrower to allow — which makes that password the only
   thing in front of your database.
4. **Connect → Drivers**, and append the database name:

```
mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/facepay?retryWrites=true&w=majority
```

Point the backend at it with `MONGODB_URI`.

## The encryption key

```bash
cd backend && npm run keygen
```

You already have one in `backend/.env`. **Use that same one** — a new key makes
every existing registration unreadable and everyone has to enrol again. It is
not recoverable and must never be committed.

---

## Before you send the link to anyone

**Open it yourself first.** A cold start or a waking tunnel is otherwise the
first thing a visitor sees.

**Register yourself first.** Verification compares a face against everyone
enrolled. With an empty database there is nothing to match, so the first person
gets `no_match` and concludes it is broken.

**Say something about consent.** People are handing biometric data to a student
project. The consent screen is honest about what is kept, but a message
beforehand goes further than a checkbox.

**Ask for a few tries each, in different light.** One attempt per person gives
you almost nothing. Five each, at different times of day, is what a real FRR
number needs.

---

## Checking on the data

```bash
cd backend
node src/scripts/dedupe.js            # duplicate registrations, dry run
node src/scripts/dedupe.js --apply    # remove them
```

Prefix with `MONGODB_URI=...` to run against a deployed database.

## When something is wrong

**`mlService.reachable: false`** — the Python service is not running, or the
backend is pointed at the wrong `ML_SERVICE_URL`.

**Everything returns `no_match`** — nobody is enrolled, or you are looking at a
different database than you think.

**Everything returns `ambiguous`** — someone is enrolled more than once. Two
copies of one face sit inside the match margin of each other, so neither can be
told from the other. Enrollment collapses repeats on its own now, so this only
affects records created before that.

**`liveness_failed` constantly** — usually light. The challenge has to see eye
and head movement clearly, and a backlit face defeats it.

**Frames crawl over the tunnel** — expected on a slow uplink. The client sends
one frame at a time and adapts, and the challenge is measured in milliseconds
rather than frames, so it still works — just slower.
