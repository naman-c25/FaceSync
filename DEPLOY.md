# Deploying — getting a link you can share

Two things to set up. Budget about half an hour the first time, most of it
waiting for a build.

| what | where | cost |
|---|---|---|
| Database | MongoDB Atlas | free |
| Everything else | Hugging Face Spaces (Docker) | free |

The kiosk, the API and the ML service all ship in one image. The Docker build
compiles the frontend and the Node service serves it, so there is one origin,
one URL, and no CORS to configure.

## Why not Vercel

The ML service cannot go there at all — it loads about a gigabyte of models,
and serverless functions have neither the memory nor a filesystem that survives
between calls.

Less obvious, and the more important point: **do not split the API and the ML
service across two hosts.** Every liveness frame travels browser → Node →
Python → back, and a separate host adds a network hop to each of the 20-30
frames in one verification. That latency lands directly on the challenge the
user is trying to complete, and the frame rate is what the blink detection
depends on.

They are still separate services — the Python side knows nothing about the
database, the Node side does no ML. Only the deployment is shared, and the call
between them is over loopback.

---

## 1. MongoDB Atlas

1. Sign up at [mongodb.com/atlas](https://www.mongodb.com/atlas) and create a
   free **M0** cluster.
2. **Database Access** → add a user. Use a long random password.
3. **Network Access** → add `0.0.0.0/0`. Hugging Face publishes no fixed egress
   IPs, so there is nothing narrower to allow. That password is now the only
   thing in front of your database — which is why it should be a long random
   one.
4. **Connect** → *Drivers* → copy the string, and add the database name:

```
mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/facepay?retryWrites=true&w=majority
```

## 2. Hugging Face Space

Free tier gives 2 vCPU and 16GB RAM. The memory is what matters — most free
tiers cap at 512MB and will not load the models at all. It also idles for 48
hours before sleeping, against the 15 minutes typical elsewhere.

1. Create an account at [huggingface.co](https://huggingface.co).
2. **New Space** → SDK **Docker** → *Blank* → **Public**.
3. Generate an encryption key and keep a copy somewhere safe:

```bash
cd backend && npm run keygen
```

4. **Settings → Variables and secrets** → add these three as **secrets**:

| name | value |
|---|---|
| `ENCRYPTION_KEY` | the 64 hex characters, without the `ENCRYPTION_KEY=` prefix |
| `MONGODB_URI` | the Atlas string from step 1 |
| `CORS_ORIGINS` | `*` — nothing else calls this API cross-origin |

**Losing the encryption key makes every stored embedding unreadable and
everyone has to register again.** It is not recoverable, and it must never be
committed.

5. Push the repository:

```bash
git remote add space https://huggingface.co/spaces/<you>/facepay
git push space main
```

The first build takes 10-15 minutes: two runtimes, then the models. When it
finishes, everything is at:

```
https://<you>-facepay.hf.space
```

Check `/health` before sharing it. It should report
`mlService.reachable: true`.

**A Space is public.** Anyone can read the code. Values set as *secrets* are
not exposed, but do not put anything in the repository you would not publish —
and note that `backend/.env` is gitignored precisely so it never gets there.

---

## Before you share the link

**The camera needs HTTPS.** Spaces provide it, so this only bites if you
improvise a host. Over plain HTTP the browser exposes no camera at all, and the
page says so rather than failing silently.

**Open it yourself first.** A sleeping Space takes 30-60 seconds to wake, and
that wait would otherwise be the first thing a visitor sees.

**Register yourself first.** Verification compares a face against everyone
enrolled. With an empty database there is nothing to match, so the first person
to try gets `no_match` and concludes it is broken.

**Say something about consent.** People are handing biometric data to a student
project. The consent screen is honest about what is stored, but a message
beforehand goes further than a checkbox.

---

## Optional: a nicer URL with Vercel

Only worth it for the domain. It also reintroduces CORS, a second host, and a
cross-origin request per frame.

```bash
cd frontend
npx vercel
```

Set `VITE_API_URL` to the Space URL in the Vercel dashboard and redeploy, then
set the Space's `CORS_ORIGINS` to the Vercel origin — not `*`, once a real
origin exists to name.

---

## Checking on the data

```bash
cd backend
MONGODB_URI="<your atlas string>" node src/scripts/dedupe.js
```

Dry run by default; add `--apply` to actually remove duplicates.

## When something is wrong

**`mlService.reachable: false`** — the Python service did not start. Check the
Space logs; usually the model download failed during the build.

**Everything returns `no_match`** — nobody is enrolled yet, or you are looking
at a different database than you think.

**Everything returns `ambiguous`** — someone is enrolled more than once. Two
copies of one face sit inside the match margin of each other, so neither can be
told from the other. Run the dedupe script. Enrollment now collapses repeat
registrations on its own, so this should only affect records created earlier.

**`liveness_failed` constantly** — usually light. The challenge has to see eye
and head movement clearly, and a backlit face defeats it.

**Frames crawl** — check where the Space is hosted relative to your users.
There is nothing to tune on the client: it already sends one frame at a time
and adapts to whatever the round trip allows.
