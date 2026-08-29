import { useEffect, useRef, useState } from 'react';

import { useSmoothScroll } from '../useSmoothScroll.js';
import { Wordmark } from './Wordmark.jsx';

/**
 * The public front page: a scroll of full-height panels over a single
 * background loop.
 *
 * The footage sits behind everything at low opacity and never moves. That is
 * deliberate on two counts — it reads as atmosphere rather than as a claim
 * that this is the product working, and a fixed layer costs nothing to scroll
 * past, where a video per section would mean several decoders running at once.
 *
 * Panels reveal as they arrive rather than animating on a timer, so the page
 * never plays something the reader has already scrolled past, and anyone who
 * has asked their system for less motion simply sees everything already in
 * place.
 *
 * The scroll itself carries momentum, and every effect on the page is driven
 * from how far a panel has travelled rather than from a duration -- so nothing
 * animates on its own schedule, and scrolling back up rewinds what scrolling
 * down played.
 *
 * Consent is not on this page. It appears at the moment a camera is actually
 * needed, because a checkbox about biometric data shown to somebody who has
 * not yet been told what the project is collects a formality, not a decision.
 */

const DEMO_VIDEO = '/demo.mp4';
const SUPPORT_EMAIL = 'nkc441710@gmail.com';

function Icon({ path, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
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
  scan: (
    <>
      <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
      <path d="M4 12h16" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  keypad: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M12 16h.01" />
    </>
  ),
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
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6 8.5-6" />
    </>
  ),
};

const STEPS = [
  { icon: I.scan, title: 'Scan', body: 'Look at the camera. Nothing to type, tap or present.' },
  { icon: I.shield, title: 'Verify', body: 'A live person is confirmed. Photographs and screens are refused.' },
  { icon: I.face, title: 'Identify', body: 'Your face is matched against everyone enrolled.' },
  { icon: I.keypad, title: 'Approve', body: 'A four-digit PIN, and the payment completes.' },
];

/**
 * Add `is-in` to an element once it has scrolled into view, and leave it there.
 *
 * One-way on purpose: a panel that fades out again as it leaves makes the page
 * feel unstable when somebody scrolls back up. Falls through to "already
 * visible" when the browser has no observer or the reader has asked for less
 * motion, so nothing is ever hidden behind an animation that will not run.
 */
function useReveal() {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const still =
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (still) {
      node.classList.add('is-in');
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        observer.disconnect();
      },
      // Fires a little before the panel is fully on screen, so the movement
      // has finished by the time the reader is looking straight at it.
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return ref;
}

function Panel({ id, className = '', children }) {
  const ref = useReveal();
  return (
    <section id={id} ref={ref} className={`panel ${className}`}>
      <div className="panel-inner">{children}</div>
    </section>
  );
}

function Backdrop() {
  const [failed, setFailed] = useState(false);

  return (
    <div className="backdrop" aria-hidden="true">
      {!failed && (
        <video
          src={DEMO_VIDEO}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          onError={() => setFailed(true)}
        />
      )}
      {/* Sits over the footage so text keeps its contrast wherever a bright
          frame happens to land. Without it legibility changes shot to shot. */}
      <div className="veil" />
    </div>
  );
}

export function Landing({ offline, onPay }) {
  const scroller = useRef(null);
  useSmoothScroll(scroller);

  return (
    <div className="landing" ref={scroller}>
      <div className="scroll">
        <span className="progress" aria-hidden="true" />

        <header className="bar">
        <Wordmark large href="/" />
        <nav>
          <a className="ghost" href="/merchant">
            Merchant
          </a>
          <a className="ghost" href="/user">
            Account
          </a>
        </nav>
      </header>

      <main>
        <Panel id="top" className="panel-hero">
          <h1>
            <span className="line">
              <span>Pay with your face.</span>
            </span>
            <span className="line dim">
              <span>No phone. No card.</span>
            </span>
          </h1>
          <p className="lead">
            Walk up to the counter, look at the camera, enter a four-digit PIN.
            That is the whole payment.
          </p>

          {offline && (
            <p className="offline">
              The recognition service is not responding. Nothing here will work
              until it is back.
            </p>
          )}

          <button className="pay" disabled={offline} onClick={onPay}>
            Pay with my face
            <span aria-hidden="true">→</span>
          </button>

          {/* Two lines, and nothing that looks like a control. Anything boxed
              or bordered here gets read before the button above it, which is
              the opposite of what the hero is for -- so this is sized to be
              noticed on the way past rather than shaped to be pressed. */}
          <p className="first-time">
            <span className="first-time-lead">
              First time here?{' '}
              <a className="link" href="/user#signup">
                Register your face
              </a>
            </span>
            <span className="first-time-note">
              A name, an email, a PIN and one face scan — about a minute.
            </span>
          </p>

          <span className="cue" aria-hidden="true">
            Scroll
          </span>
        </Panel>

        <Panel id="how">
          <span className="eyebrow">How it works</span>
          <h2>Four steps, about four seconds.</h2>

          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} style={{ '--i': index }}>
                <span className="step-icon">
                  <Icon path={step.icon} />
                </span>
                <span className="step-n">{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>

          <p className="outcome">
            Paid — and no image of your face is stored, only an encrypted
            signature you can delete yourself.
          </p>
        </Panel>

        <Panel id="portals">
          <span className="eyebrow">Two sides</span>
          <h2>Built for both ends of the counter.</h2>

          <div className="cards">
            <a className="card" href="/merchant">
              <span className="step-icon">
                <Icon path={I.store} />
              </span>
              <h3>Merchant portal</h3>
              <p>
                Open a shop account, take payments, print receipts, and read
                back everything the terminal has taken.
              </p>
              <span className="card-go">Sign in or sign up →</span>
            </a>

            <a className="card" href="/user">
              <span className="step-icon">
                <Icon path={I.user} />
              </span>
              <h3>User portal</h3>
              <p>
                Sign up with your face, then see your own payments, change your
                PIN, and delete your face data whenever you want.
              </p>
              <span className="card-go">Sign in or sign up →</span>
            </a>
          </div>
        </Panel>

        <Panel id="support">
          <span className="eyebrow">Support</span>
          <h2>Something not working?</h2>
          <p className="lead">
            Customers and merchants both. If you are stuck, or you would like a
            merchant terminal of your own, write to me directly.
          </p>
          <a className="mailto" href={`mailto:${SUPPORT_EMAIL}`}>
            <Icon path={I.mail} />
            {SUPPORT_EMAIL}
          </a>
        </Panel>
      </main>

        <footer className="foot">
          <span>FaceSync</span>
          <span>
            Prototype for the Razorpay hackathon — payments run in test mode,
            and the background footage is an illustration rather than a
            recording.
          </span>
        </footer>
      </div>

      {/* Outside the scrolling content on purpose: it is fixed to the viewport
          and must not be measured as part of the page's height. */}
      <Backdrop />
    </div>
  );
}
