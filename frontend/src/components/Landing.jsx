import { useState } from 'react';

/**
 * The public front page: what someone sees before anything asks for their face.
 *
 * Two things about it are deliberate.
 *
 * Consent used to be the first screen a visitor saw — a checkbox about
 * biometric data, shown to somebody who had not yet been told what the project
 * was. Consent given at that point is a formality rather than a decision, so
 * the explanation comes first and the checkbox comes at the moment a camera is
 * actually needed.
 *
 * And every claim here is one that can be checked. "Bank-grade security" and
 * "advanced AI" say nothing; "512 numbers, AES-256-GCM, no image kept"
 * describes what the code does. Where a figure appears it is quoted with the
 * conditions that produced it, because a number without its conditions is a
 * slogan.
 */

const DEMO_VIDEO = '/demo.mp4';

function Icon({ path, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {path}
    </svg>
  );
}

const I = {
  face: (
    <>
      <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
      <circle cx="12" cy="11" r="2.6" />
      <path d="M7.6 17.8a5 5 0 0 1 8.8 0" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M11 18.5h2M3 3l18 18" />
    </>
  ),
  bolt: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />,
  store: (
    <>
      <path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M3.5 9 5 3.5h14L20.5 9M9.5 21v-6h5v6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  hash: <path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" />,
  key: (
    <>
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 9 9M17 17l2-2M14 14l2-2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
};

/** Hero feature list — four, matching the reference layout. */
const FEATURES = [
  {
    icon: I.face,
    title: 'Face Recognition',
    body: 'Identifies you against everyone enrolled — you never type a name or number first.',
  },
  {
    icon: I.eye,
    title: 'Liveness Detection',
    body: 'Confirms a real person is physically present, without asking you to blink or turn.',
  },
  {
    icon: I.shield,
    title: 'Anti-Spoofing',
    body: 'Rejects printed photos, phone screens and replayed video before identification runs.',
  },
  {
    icon: I.lock,
    title: 'Secure PIN Verification',
    body: 'A four-digit PIN approves the payment. Your face says who; the PIN says yes.',
  },
];

/** The compact flow shown inside the demo panel. */
const FLOW = ['Face Detected', 'Liveness & Anti-Spoofing', 'Enter 4-Digit PIN', 'Payment Successful'];

const TRUST = [
  { icon: I.phone, title: 'Phone-less Experience', body: 'No need to carry your phone' },
  { icon: I.shield, title: 'Secure & Private', body: 'Encrypted signatures, never images' },
  { icon: I.bolt, title: 'Fast Transactions', body: 'Verify and pay in seconds' },
  { icon: I.store, title: 'Built for Merchants', body: 'A real till flow, end to end' },
];

/** The six stages, given room to explain themselves. */
const STEPS = [
  {
    n: '01',
    title: 'Merchant enters the amount',
    body: 'The till creates a payment request. Nothing about you is involved yet.',
  },
  {
    n: '02',
    title: 'Your face is found',
    body: 'A detector locates exactly one face. Two faces stops it — the person behind you must not be able to pay by accident.',
  },
  {
    n: '03',
    title: 'Liveness and anti-spoofing',
    body: 'A passive check watches for the involuntary motion a live head makes, and two small networks read texture to rule out a photo or a screen.',
  },
  {
    n: '04',
    title: 'Identity match',
    body: 'Your face becomes 512 numbers and is compared against every enrolled person. Identification, not verification — the system has to pick you out.',
  },
  {
    n: '05',
    title: 'PIN confirmation',
    body: 'Four digits, entered by you. Recognition alone should never move money; something you know has to agree with something you are.',
  },
  {
    n: '06',
    title: 'Payment completed',
    body: 'The transaction is recorded and a receipt is produced. Razorpay runs in test mode — no real money moves.',
  },
];

const SECURITY = [
  {
    icon: I.face,
    title: 'Facial Identity Matching',
    body: 'Compares the live facial embedding against the enrolled identity, and requires both a similarity threshold and a clear lead over the runner-up before deciding.',
  },
  {
    icon: I.eye,
    title: 'Liveness Detection',
    body: 'Checks whether the person interacting with the system is physically present, rather than trusting that a face in frame belongs to someone standing there.',
  },
  {
    icon: I.shield,
    title: 'Anti-Spoofing Protection',
    body: 'Detects spoof attempts using non-live facial representations — printed photographs, phone and monitor screens, and replayed video.',
  },
  {
    icon: I.lock,
    title: 'Secure PIN Confirmation',
    body: 'Adds a second verification layer before a payment completes, with a lockout after repeated wrong attempts.',
  },
];

const PRIVACY_FLOW = [
  { icon: I.camera, label: 'Camera frame', note: 'Held in memory only' },
  { icon: I.cpu, label: 'Face processing', note: 'Detected, aligned, measured' },
  { icon: I.hash, label: 'Generate embedding', note: '512 numbers, one-way' },
  { icon: I.key, label: 'Encrypt embedding', note: 'AES-256-GCM' },
  { icon: I.database, label: 'Secure storage', note: 'Ciphertext, never an image' },
];

function DemoPanel() {
  const [videoFailed, setVideoFailed] = useState(false);

  return (
    <div className="demo-panel">
      <div className="demo-chrome">
        <span className="demo-mark">
          <Icon path={I.face} />
          FaceSync
        </span>
        <span className="demo-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="demo-stage">
        {videoFailed ? (
          /* An honest placeholder rather than fake player chrome. The point of
             this panel is to prove the system works, so it either shows a real
             recording of it working or it says there isn't one yet. */
          <div className="demo-empty">
            <Icon path={I.camera} className="demo-empty-icon" />
            <strong>Demo recording not added yet</strong>
            <p className="muted">
              Drop a screen recording of the real flow at{' '}
              <code>frontend/public/demo.mp4</code> and it appears here.
            </p>
          </div>
        ) : (
          <video
            className="demo-video"
            src={DEMO_VIDEO}
            controls
            playsInline
            preload="metadata"
            onError={() => setVideoFailed(true)}
          />
        )}
      </div>

      <ol className="demo-flow" aria-label="Steps in a payment">
        {FLOW.map((label, index) => (
          <li key={label}>
            <span className="demo-flow-step">
              <span className="demo-flow-tick" aria-hidden="true">
                ✓
              </span>
              {label}
            </span>
            {index < FLOW.length - 1 && (
              <span className="demo-flow-arrow" aria-hidden="true">
                ›
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Landing({ offline, onCheck, onPay, onRegister }) {
  return (
    <div className="landing">
      <header className="nav">
        <a className="nav-brand" href="/">
          <span className="nav-logo">
            <Icon path={I.face} />
          </span>
          <span>
            <strong>FaceSync</strong>
            <em>Your Face. Your Identity. Your Payment.</em>
          </span>
        </a>

        {/* Real navigation. Two audiences part here, and neither should have to
            read past the other's door to find their own. */}
        <nav className="nav-portals">
          <a className="portal" href="/till">
            <Icon path={I.store} />
            <span>
              <strong>Merchant Portal</strong>
              <em>Login / Sign up</em>
            </span>
          </a>
          <a className="portal" href="/account">
            <Icon path={I.user} />
            <span>
              <strong>User Portal</strong>
              <em>Login / Sign up</em>
            </span>
          </a>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Secure. Fast. Contactless.</span>

          <h1>
            Pay without
            <br />
            your phone.
            <br />
            <span className="grad-text">Just be you.</span>
          </h1>

          <p className="lede">
            FaceSync is a phone-less biometric payment system that verifies your
            identity using facial recognition, liveness detection, anti-spoofing,
            and a secure 4-digit PIN before completing a payment.
          </p>

          {offline && (
            <p className="note bad">
              The recognition service is not responding, so nothing on this page
              will work until it is back up.
            </p>
          )}

          <ul className="feature-list">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <span className="feature-icon">
                  <Icon path={feature.icon} />
                </span>
                <span>
                  <strong>{feature.title}</strong>
                  <span className="muted">{feature.body}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="trust-callout">
            <span className="feature-icon sm">
              <Icon path={I.shield} />
            </span>
            Your face is stored as an encrypted signature, never as an image,
            and you can delete it yourself at any time.
          </p>
        </div>

        <div className="hero-demo">
          <DemoPanel />

          <button
            className="cta-secondary"
            disabled={offline}
            onClick={onCheck}
          >
            <span className="cta-icon">
              <Icon path={I.search} />
            </span>
            <span>
              <strong>Check whether your face is already registered</strong>
              <em>Runs the real match and stops there — no PIN, no payment</em>
            </span>
            <span className="cta-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          <div className="or-divider">
            <span>OR</span>
          </div>

          <button className="cta-primary" disabled={offline} onClick={onPay}>
            <span className="cta-icon">
              <Icon path={I.face} />
            </span>
            <span>
              <strong>If registered, pay with your face</strong>
              <em>Start a payment using your face in seconds</em>
            </span>
            <span className="cta-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          <p className="note">
            First time here?{' '}
            <button className="inline-link" onClick={onRegister}>
              Register your face
            </button>{' '}
            first — paying compares you against everyone already enrolled, so
            there is nothing to match you to until you are in that list.
          </p>
        </div>
      </section>

      <section className="trust-strip">
        {TRUST.map((item) => (
          <div key={item.title}>
            <span className="feature-icon sm">
              <Icon path={item.icon} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <em>{item.body}</em>
            </span>
          </div>
        ))}
      </section>

      <section className="band">
        <h2>One payment. Multiple layers of verification.</h2>
        <p className="lede band-lede">
          Six stages between a merchant typing an amount and a receipt printing.
          Any one of them can stop the payment, and each fails by refusing
          rather than guessing.
        </p>

        <ol className="steps-row">
          {STEPS.map((step) => (
            <li className="step-card" key={step.n}>
              <span className="step-n">{step.n}</span>
              <strong>{step.title}</strong>
              <p className="muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band">
        <h2>Designed with verification at every step.</h2>
        <p className="lede band-lede">
          Four independent checks. A face that passes one and fails another does
          not get through on the strength of the first.
        </p>

        <div className="grid-4">
          {SECURITY.map((item) => (
            <div className="card sec-card" key={item.title}>
              <span className="feature-icon">
                <Icon path={item.icon} />
              </span>
              <strong>{item.title}</strong>
              <p className="muted">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="band">
        <h2>Your face is not your password.</h2>
        <p className="lede band-lede">
          A password can be changed after a leak. Your face cannot — which is
          why what gets stored matters more here than almost anywhere else.
        </p>

        <ol className="privacy-flow">
          {PRIVACY_FLOW.map((stage, index) => (
            <li key={stage.label}>
              <span className="privacy-node">
                <span className="privacy-mark">
                  <Icon path={stage.icon} />
                </span>
                <strong>{stage.label}</strong>
                <em>{stage.note}</em>
              </span>
              {index < PRIVACY_FLOW.length - 1 && (
                <span className="privacy-arrow" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>

        <p className="highlight-line">
          No raw facial images are required for the production identity-matching
          flow.
        </p>
      </section>

      <section className="band">
        <h2>Built for both sides of the payment.</h2>

        <div className="grid-2">
          <div className="card path-card">
            <span className="feature-icon">
              <Icon path={I.store} />
            </span>
            <strong>Merchant</strong>
            <ul className="plain-list">
              <li>Create payment requests</li>
              <li>Enter transaction amount</li>
              <li>Monitor payment status</li>
            </ul>
            <a className="btn btn-secondary" href="/till">
              Open Merchant Portal →
            </a>
          </div>

          <div className="card path-card">
            <span className="feature-icon">
              <Icon path={I.user} />
            </span>
            <strong>User</strong>
            <ul className="plain-list">
              <li>Enroll your biometric identity</li>
              <li>Check registration status</li>
              <li>Pay using FaceSync</li>
            </ul>
            <a className="btn btn-secondary" href="/account">
              Open User Portal →
            </a>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <h2>Ready to experience phone-less payments?</h2>
        <p className="lede">
          Verify your identity. Confirm with your PIN. Complete your payment.
        </p>
        <div className="final-cta-row">
          <button
            className="btn btn-secondary"
            disabled={offline}
            onClick={onCheck}
          >
            Check registration
          </button>
          <button className="btn btn-grad" disabled={offline} onClick={onPay}>
            Pay with your face →
          </button>
        </div>
      </section>

      <footer className="site-foot">
        <div>
          <strong>FaceSync</strong>
          <em>Your Face. Your Identity. Your Payment.</em>
        </div>
        <nav>
          <a
            href="https://github.com/naman-c25/FaceSync"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub
          </a>
        </nav>
        <small>
          Built as a biometric payment system project for the Razorpay
          hackathon. Payments run in test mode — no real money moves.
        </small>
      </footer>
    </div>
  );
}
