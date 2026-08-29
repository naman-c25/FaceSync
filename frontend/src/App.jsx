import { useEffect, useState } from 'react';

import { api } from './api.js';
import { Consent } from './components/Consent.jsx';
import { Enroll } from './components/Enroll.jsx';
import { Landing } from './components/Landing.jsx';
import { Result } from './components/Result.jsx';
import { Verify } from './components/Verify.jsx';
import { Wordmark } from './components/Wordmark.jsx';

const MERCHANT_ID = import.meta.env.VITE_MERCHANT_ID ?? 'demo-shop';
const CONSENT_KEY = 'facepay.consent.v1';

export default function App() {
  // Remembered so a returning visitor is not asked again. Wrapped because a
  // private window or blocked site data makes the accessor itself throw.
  const [consented, setConsented] = useState(() => {
    try {
      return localStorage.getItem(CONSENT_KEY) === 'yes';
    } catch {
      return false;
    }
  });

  const [screen, setScreen] = useState('home');
  // Where to go once consent is given. Consent used to be the first screen a
  // visitor saw, which made it a formality -- a checkbox about biometric data
  // shown to someone who had not yet been told what the project was. It now
  // appears at the point the camera is actually needed, and this remembers
  // what they were trying to do when it interrupted them.
  const [pending, setPending] = useState(null);
  // Whether this run stops at identification. "Check registration" and
  // "pay" are the same camera flow up to the moment a name comes back --
  // same session, same liveness, same anti-spoofing, same 1:N match -- and
  // differ only in whether a PIN is then asked for. Running them as one
  // flow with a flag means the check exercises the real path rather than a
  // lookalike of it.
  const [checkOnly, setCheckOnly] = useState(false);
  const [result, setResult] = useState(null);
  const [enrolled, setEnrolled] = useState(null);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ down: true }));
  }, []);

  const accept = () => {
    try {
      localStorage.setItem(CONSENT_KEY, 'yes');
    } catch {
      // A viewer who blocks storage still gets through — they are just asked
      // again next visit.
    }
    setConsented(true);
    setScreen(pending ?? 'home');
    setPending(null);
  };

  // Every route to a camera goes through here, so there is exactly one place
  // that can be wrong about whether consent was given.
  const start = (target, options = {}) => {
    setCheckOnly(Boolean(options.checkOnly));
    if (consented) {
      setScreen(target);
      return;
    }
    setPending(target);
    setScreen('consent');
  };

  const home = () => {
    setResult(null);
    setEnrolled(null);
    setPending(null);
    setCheckOnly(false);
    setScreen('home');
  };

  let body;

  if (screen === 'consent') {
    body = <Consent onAccept={accept} />;
  } else if (screen === 'enroll') {
    body = (
      <Enroll
        onCancel={home}
        onDone={(done) => {
          setEnrolled(done);
          setScreen('enrolled');
        }}
      />
    );
  } else if (screen === 'verify') {
    body = (
      <Verify
        merchantId={MERCHANT_ID}
        checkOnly={checkOnly}
        onCancel={home}
        onDone={(matched) => {
          setResult(matched);
          setScreen('result');
        }}
      />
    );
  } else if (screen === 'result') {
    body = (
      <Result
        result={result}
        checkOnly={checkOnly}
        onAgain={() => setScreen('verify')}
        onPay={() => start('verify')}
        onEnrol={() => setScreen('enroll')}
      />
    );
  } else if (screen === 'enrolled') {
    const weak = enrolled.enrollment.meanSimilarity < 0.85;
    body = (
      <div className="screen">
        <div className="card verdict">
          <div className={`badge${enrolled.updatedExisting ? ' unsure' : ''}`}>
            {enrolled.updatedExisting ? '!' : '✓'}
          </div>
          <h2>
            {enrolled.updatedExisting
              ? 'You have registered before'
              : 'You are registered'}
          </h2>
          <p className="muted">
            {enrolled.updatedExisting
              ? `We recognised your face from an existing registration, under the name ${enrolled.displayName}. Your face data has been refreshed rather than stored a second time.`
              : `${enrolled.enrollment.samplesUsed} samples became one encrypted signature. No image of you was kept.`}
          </p>
        </div>

        {enrolled.nameDiffers && (
          <p className="note warn">
            You entered <strong>{enrolled.nameGiven}</strong>, but this face is
            already registered as <strong>{enrolled.displayName}</strong>. The
            name on file was left as it is — a face that is already known
            cannot be renamed by registering again.
          </p>
        )}

        {enrolled.updatedExisting && (
          <p className="note">
            Matched your existing registration at{' '}
            <strong>{enrolled.matchedScore?.toFixed(3)}</strong> similarity.
            Storing a second copy would leave two near-identical faces in the
            system — after which neither could be told from the other, and you
            could not be identified at all.
          </p>
        )}

        {weak && (
          <p className="note warn">
            Your samples varied more than ideal (
            {enrolled.enrollment.meanSimilarity.toFixed(2)} agreement).
            Recognition may be less reliable — worth registering again in
            steadier light.
          </p>
        )}

        <div className="stack">
          <button className="btn btn-primary" onClick={() => setScreen('verify')}>
            Now try paying
          </button>
          <button className="btn btn-ghost" onClick={home}>
            Done
          </button>
        </div>
      </div>
    );
  } else {
    const offline = health?.down || health?.mlService?.reachable === false;

    body = (
      <Landing
        offline={offline}
        onPay={() => start('verify')}
      />
    );
  }

  return (
    <div className={`app${screen === 'home' ? ' app-wide' : ''}`}>
      {/* Kiosk chrome only. The landing page carries its own navbar and
          footer, and rendering these above it would be a second, smaller copy
          of both. */}
      {screen !== 'home' && (
        <header className="masthead">
          <Wordmark />
          <button className="link-button" onClick={home}>
            Start over
          </button>
        </header>
      )}

      {body}

      {screen !== 'home' && (
        <footer>Prototype — Razorpay hackathon. Not a real payment system.</footer>
      )}
    </div>
  );
}
