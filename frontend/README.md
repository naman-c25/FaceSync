# Frontend — the kiosk

React + Vite. Mobile-first, because everyone you share the link with will open
it on a phone.

## Running locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Vite proxies `/api` and `/health` to `http://127.0.0.1:3000`, so during
development everything is same-origin and CORS never comes up. Point it
somewhere else with `DEV_API_TARGET` if the backend is on another port.

`server.host` is on, so the dev server is reachable from a phone on the same
wifi — the only way to test the mobile path before deploying. Note that a phone
hitting `http://192.168.x.x:5173` will **not** get camera access; see below.

## The camera needs HTTPS

Browsers expose `getUserMedia` only in a secure context. `localhost` counts;
`http://192.168.1.5:5173` and `http://your-app.example.com` do not — the API is
simply absent, and the UI says so rather than failing silently.

This is not a warning to work around. It decides where you can host: any
deployment target has to serve the frontend over HTTPS, and the backend too, or
the browser will block the mixed-content request.

For testing on a phone before deploying, the easiest route is a tunnel:

```bash
npx localtunnel --port 5173      # or: ngrok http 5173
```

Both hand back an HTTPS URL.

## Deploying

Four pieces, and only one of them is awkward.

| piece | where | notes |
|---|---|---|
| Frontend | Vercel, Netlify, Cloudflare Pages | static build, HTTPS by default, free |
| MongoDB | MongoDB Atlas | free tier is 512MB — far more than enough |
| Backend | Render, Railway, Fly.io | small; needs `ENCRYPTION_KEY` and `MONGODB_URI` |
| ML service | Railway, Cloud Run, HF Spaces | the awkward one — see below |

Build the frontend against a deployed backend:

```bash
VITE_API_URL=https://your-backend.example.com npm run build
# dist/ is what you upload
```

`VITE_MERCHANT_ID` sets which merchant the attempts are logged against, if you
want to tell two demo locations apart in the data.

### The ML service is the constraint

It loads InsightFace and MediaPipe and wants roughly a gigabyte of memory. A
512MB free tier will not run it. `Dockerfile` bakes the models into the image
so a cold start does not begin with a 300MB download — without that, the first
visitor after the service sleeps waits it out.

Whatever you pick, set the backend's `ML_SERVICE_URL` to it, and set
`CORS_ORIGINS` on the backend to the frontend's origin rather than leaving the
`*` default.

**Cold starts are the thing that will embarrass you in a demo.** Free tiers
sleep after inactivity and take 30-60 seconds to come back. Open the health
endpoint yourself a minute before anyone else does.

## Bandwidth

A verification sends roughly 15-30 frames of about 30KB each — call it a
megabyte per attempt. Frames are captured at 540px on the long edge and JPEG
quality 0.8, which is small enough for mobile data and still well above the
112px ArcFace works from.

Frames go out one at a time, each sent only after the previous response
arrives. There is no timer: a fixed interval would queue requests behind a slow
connection and drift further and further behind what the camera is showing.
The effective rate becomes whatever the round trip allows, and the server
measures the challenge in milliseconds rather than frames so it behaves the
same at 5fps as at 30.

## Notes

**The preview is mirrored; the captured frame is not.** An unmirrored self-view
feels wrong to look at, so the video element is flipped in CSS. The frame drawn
to canvas is deliberately left alone — the backend reads gaze direction in
image coordinates and assumes an unflipped frame, so mirroring the capture
would invert every "look left". If a gaze challenge starts failing in one
direction only, this is the first thing to check.

**Consent is a screen, not a footnote.** What is being collected is biometric
data, taken from friends and family over a shared link. The wording avoids
reassuring vagueness — "securely stored" tells nobody anything, while "512
numbers, encrypted, no photo kept" is something a person can actually check.
The choice is remembered in `localStorage` so returning visitors are not asked
twice.
