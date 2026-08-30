# Frontend — three apps, one stylesheet

React + Vite. Mobile-first, because everyone you share the link with will open
it on a phone.

## The three surfaces

Split by path, not folded together. Nothing customer-facing should carry code
that charges money.

| path | who | what |
|---|---|---|
| `/` | anyone | landing page, and the kiosk pay flow |
| `/user` | customer | sign in / sign up, payment settings, history |
| `/merchant` | shop | sign in / sign up, till, payment history |

`/user` and `/merchant` are the routes. There were `/account` and `/till`
aliases for a while; they were removed rather than kept, so there is one URL per
surface.

**Sign-up differs by side.** A shop needs name, email and password. A customer
needs those plus a PIN plus a face scan — and if that face is already
registered, they are told so and asked for its PIN instead of silently getting a
second record.

Shared pieces live in `src/components/`: `Wordmark.jsx` and `SettingRow.jsx` are
used by all three so the surfaces stay visually identical.

**Scrolling.** The landing page uses Lenis for momentum scrolling
(`useSmoothScroll.js`), with a try/catch fallback to native scroll if it fails to
load. Scroll progress is written to CSS custom properties (`--scroll`, `--p`)
rather than React state, so a scroll does not re-render the tree.

**Watch out for unscoped CSS.** One stylesheet across three apps means a generic
selector reaches further than intended. Landing-page `.steps` and `.card` rules
once overrode the camera's liveness dots and the kiosk cards. Landing styles are
now scoped under `.landing`.

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
ngrok http 5173 --domain=<your-static-domain>
```

Expose 5173, not 3000 — the dev server proxies `/api` to the backend, so one
tunnel serves the whole system.

Vite refuses requests whose Host header it does not recognise, which is what
stops a page on another site from reaching this dev server through a browser.
Tunnel hostnames are listed in `vite.config.js`; a host it does not cover goes
in `DEV_TUNNEL_HOST` rather than switching the check off, because this server
proxies to an API that can charge a face.

Both hand back an HTTPS URL.

## Deploying

**All three services ship as one image.** The root `Dockerfile` builds the
frontend into the Node service and runs Python alongside it, so there is one
URL, no CORS, and no `VITE_API_URL` to set. `DEPLOY.md` has the detail.

```bash
npm run build:serve    # build straight into the backend's static directory
```

Splitting the frontend onto Vercel and the API elsewhere would work, but every
liveness frame travels browser → Node → Python → back, and splitting adds a hop
to each of the 20-30 frames in one scan.

If you do split it:

```bash
VITE_API_URL=https://your-backend.example.com npm run build
# dist/ is what you upload
```

...and set `CORS_ORIGINS` on the backend to the frontend's origin rather than
leaving the `*` default.

Which shop an attempt is logged against is decided by the server, not by the
page: the kiosk is always booked to `KIOSK_MERCHANT_ID` and a till to whatever
its token says. A terminal that could name its own shop was how an unapproved
one used to scan customers anyway.

### The free tier is slower, and users will notice

All the ML runs on the server's CPU. On a free container that CPU is slow and
shared, so **a scan on the live URL takes noticeably longer than on a laptop** —
the same 12-frame batch is 149ms locally and about 1800ms deployed. The UI is
built for it: frames go out one at a time, the progress state is driven by
responses rather than a timer, and nothing assumes a frame rate.

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

**A failed start left a dead camera panel.** When enrollment is entered with
details already filled in, the form that renders error messages is skipped — so a
failed `startEnrollment` showed nothing at all, just a camera that never came on.
The preset path now sets the failed phase itself.

**Anything boxed reads as a control.** The "not registered yet?" line on the
landing page was tried as a bordered panel with an outlined button, and it pulled
attention before the Pay button did. It is a plain sentence now. Hierarchy on
this page comes from fill, not from borders.
