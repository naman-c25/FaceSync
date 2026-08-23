import { useState } from 'react';

/**
 * What people agree to before their face is captured.
 *
 * This exists because the thing being collected is biometric data, taken from
 * friends and family over a shared link. Under India's DPDP Act biometric data
 * needs informed consent, and beyond the legal point, anyone lending their face
 * to a hackathon project is owed a plain account of what happens to it.
 *
 * The wording avoids reassuring vagueness. "Securely stored" tells nobody
 * anything; "a list of 512 numbers, encrypted, no photo kept" is checkable.
 */
export function Consent({ onAccept }) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="screen">
      <div className="stack">
        <h1>
          Pay with your face.
          <br />
          No phone. No card.
        </h1>
        <p className="lede">
          A prototype for the Razorpay hackathon. You walk up, the camera
          recognises you, and that is the whole interaction — you never type or
          tap anything.
        </p>
      </div>

      <div className="card stack">
        <h2>Before you try it</h2>
        <ul className="facts">
          <li>
            <span className="mark">✓</span>
            <span>
              Your face is converted into <strong>512 numbers</strong> — a
              mathematical fingerprint. That is encrypted and stored.
            </span>
          </li>
          <li>
            <span className="mark no">✕</span>
            <span>
              <strong>No photo or video of you is ever saved.</strong> Frames
              are processed and discarded.
            </span>
          </li>
          <li>
            <span className="mark no">✕</span>
            <span>
              <strong>Registering asks for no phone number and no email.</strong>{' '}
              Paying never needs one either — you are recognised by your face
              alone. If you later want to see your own payments from home you
              can add an email then, and that is a separate choice.
            </span>
          </li>
          <li>
            <span className="mark">✓</span>
            <span>
              You can delete your face data yourself, at any time, and it is a
              real deletion rather than a hidden flag.
            </span>
          </li>
          <li>
            <span className="mark">✓</span>
            <span>
              This is a student prototype for a demo. Ask and it gets deleted —
              there is no catch.
            </span>
          </li>
        </ul>
      </div>

      <label className="consent-check">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        <span>
          I understand my face will be turned into an encrypted numeric
          signature and stored for this prototype.
        </span>
      </label>

      <button
        className="btn btn-primary"
        disabled={!agreed}
        onClick={onAccept}
      >
        Continue
      </button>
    </div>
  );
}
