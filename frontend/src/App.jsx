import { useEffect, useState } from 'react';

import { api } from './api.js';
import { Consent } from './components/Consent.jsx';
import { Enroll } from './components/Enroll.jsx';
import { Result } from './components/Result.jsx';
import { Verify } from './components/Verify.jsx';

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
  };

  const home = () => {
    setResult(null);
    setEnrolled(null);
    setScreen('home');
  };

  let body;

  if (!consented) {
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
        onAgain={() => setScreen('verify')}
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
      <div className="screen">
        <div className="stack">
          <h1>Ready when you are</h1>
          <p className="lede">
            Register once, then walk up and pay. Your face says who you are;
            a PIN says yes. You never identify yourself first.
          </p>
        </div>

        {offline && (
          <p className="note bad">
            The recognition service is not responding. Nothing will work until
            it is back up.
          </p>
        )}

        <div className="stack">
          <button
            className="btn btn-primary"
            disabled={offline}
            onClick={() => setScreen('verify')}
          >
            Pay with my face
          </button>
          <button
            className="btn btn-secondary"
            disabled={offline}
            onClick={() => setScreen('enroll')}
          >
            Register my face
          </button>
        </div>

        <p className="note">
          First time here? Register first — verification compares you against
          everyone already enrolled, so there is nothing to match until you are
          in that list.
        </p>

        {/* One link can be shared with everyone: customers register here,
            and the shopkeeper reaches their own terminal from the same page.
            The till is a separate screen behind a login, not a mode of this
            one — nothing customer-facing should carry code that charges. */}
        <a className="btn btn-ghost" href="/till">
          I'm a merchant — open the till
        </a>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          <span className="dot" />
          FaceSync
        </div>
        {consented && screen !== 'home' && (
          <button className="link-button" onClick={home}>
            Start over
          </button>
        )}
      </header>

      {body}

      <footer>Prototype — Razorpay hackathon. Not a real payment system.</footer>
    </div>
  );
}
