import { useCallback, useEffect, useState } from 'react';

import { merchantApi, tokenStore } from './api.js';
import { Receipt } from './Receipt.jsx';
import { Till } from './Till.jsx';
import { Wordmark } from '../components/Wordmark.jsx';
import { SettingRow } from '../components/SettingRow.jsx';

/**
 * The merchant terminal: sign in, take payments, review the day's takings.
 *
 * A separate entry point from the customer kiosk rather than a mode inside it.
 * The two have different audiences, different auth, and nothing in common but
 * the camera — folding them together would mean every customer-facing screen
 * carries code that can charge money.
 */
export function MerchantApp() {
  const [merchant, setMerchant] = useState(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState('till');

  // Restore the session on load so a terminal reload does not require signing
  // in again mid-shift.
  useEffect(() => {
    if (!tokenStore.get()) {
      setChecking(false);
      return;
    }

    merchantApi
      .me()
      .then(setMerchant)
      .catch(() => tokenStore.clear())
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(() => {
    merchantApi.logout();
    setMerchant(null);
    setView('till');
  }, []);

  if (checking) {
    return (
      <div className="app">
        <div className="screen">
          <div className="card verdict">
            <div className="spinner" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <Wordmark />
        {merchant && (
          <button
            className="header-action"
            onClick={() => setView(view === 'till' ? 'history' : 'till')}
          >
            {view === 'till' ? 'Payments' : 'Till'}
          </button>
        )}
      </header>

      {!merchant ? (
        <SignIn onSignedIn={setMerchant} />
      ) : merchant.verified === false ? (
        /* Shown instead of the till rather than as a banner above it. A
           terminal that looks ready and then refuses at the camera wastes the
           customer's time as well as the shop's, and the API would refuse it
           anyway. */
        <Pending merchant={merchant} onSignOut={signOut} />
      ) : view === 'till' ? (
        <Till merchant={merchant} onSignOut={signOut} />
      ) : (
        <History merchant={merchant} onBack={() => setView('till')} />
      )}

      <footer>Prototype — Razorpay hackathon. Test mode, no real money.</footer>
    </div>
  );
}

/**
 * Sign in, or open a shop account.
 *
 * Signing up grants the account and nothing else: the terminal it creates
 * cannot start a scan until somebody approves it, and the screen says so
 * rather than letting a shop find out with a customer already standing there.
 *
 * That split is deliberate. Charging needs the customer's own PIN, so a
 * stranger's terminal cannot take money — what it could do, unapproved, is
 * point a camera at a queue and be told everybody's name.
 */
/** A shop that has signed up but has not been approved to use a camera. */
function Pending({ merchant, onSignOut }) {
  return (
    <div className="screen">
      <div className="card verdict">
        <div className="badge unsure">!</div>
        <h2>Waiting for approval</h2>
        <p className="muted">
          <strong>{merchant.name}</strong> is set up, and its terminal is not
          switched on yet.
        </p>
      </div>

      <p className="note">
        A terminal does more than take money — it points a camera at somebody
        and is told their name. That is why the account is yours the moment you
        sign up, and the camera is not.
      </p>

      <dl className="scores">
        <div>
          <dt>Terminal</dt>
          <dd className="mono">{merchant.merchantId}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>Pending</dd>
        </div>
      </dl>

      <p className="note">
        Send that terminal id to <strong>nkc441710@gmail.com</strong> and it
        will be switched on. Nothing here needs to be set up again afterwards —
        sign in and the till will be waiting.
      </p>

      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

function SignIn({ onSignedIn }) {
  const [mode, setMode] = useState('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const joining = mode === 'up';

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(
        joining
          ? await merchantApi.register(name.trim(), email.trim(), password)
          : await merchantApi.login(email.trim(), password),
      );
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next) => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="screen">
      <div className="stack">
        <h1>{joining ? 'Open a shop account' : 'Merchant sign in'}</h1>
        <p className="lede">
          {joining
            ? 'Anyone can open one. Its terminal cannot scan a customer until the account is approved — a camera that names people is not something a new account should get on its own.'
            : "This terminal takes payments from customers' faces."}
        </p>
      </div>

      <div className="tabs">
        <button
          className={`tab${joining ? '' : ' active'}`}
          onClick={() => switchTo('in')}
        >
          Sign in
        </button>
        <button
          className={`tab${joining ? ' active' : ''}`}
          onClick={() => switchTo('up')}
        >
          Sign up
        </button>
      </div>

      <form className="card stack" onSubmit={submit}>
        {joining && (
          <div className="field">
            <label htmlFor="shop">Shop name</label>
            <input
              id="shop"
              type="text"
              autoComplete="organization"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              required
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={joining ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={joining ? 10 : 1}
            required
          />
          {joining && (
            <p className="muted">At least ten characters.</p>
          )}
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy
            ? joining
              ? 'Creating…'
              : 'Signing in…'
            : joining
              ? 'Create account'
              : 'Sign in'}
        </button>
        {error && <p className="note bad">{error}</p>}

        {/* No self-service reset here, and it is not an oversight. A customer
            can prove themselves with a PIN and a face; a shop account has
            neither, so anything automatic would come down to "whoever controls
            the mailbox", and nothing here sends mail. Asking a human is the
            honest version of that. */}
        {!joining && (
          <a
            className="linkish"
            href="mailto:nkc441710@gmail.com?subject=FaceSync%20merchant%20password%20reset"
          >
            Forgotten your password?
          </a>
        )}
      </form>
    </div>
  );
}

function History({ merchant, onBack }) {
  // A customer who comes back an hour later wanting proof should not need the
  // shopkeeper to remember anything. Every row can produce its own slip.
  const [receipt, setReceipt] = useState(null);
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([merchantApi.transactions(50), merchantApi.stats()])
      .then(([transactions, s]) => {
        setData(transactions);
        setStats(s);
      })
      .catch((cause) => setError(cause.message));
  }, []);

  if (error) {
    return (
      <div className="screen">
        <p className="note bad">{error}</p>
        <button className="btn btn-primary" onClick={onBack}>
          Back to till
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  // The history row carries everything the slip needs, so reprinting one does
  // not cost a round trip.
  if (receipt) {
    return (
      <Receipt
        merchant={merchant}
        payment={receipt}
        onDone={() => setReceipt(null)}
      />
    );
  }

  return (
    <div className="screen">
      <div className="profile">
        <span className="profile-glyph">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
            <path d="M3.5 9 5 3.5h14L20.5 9M9.5 21v-6h5v6" />
          </svg>
        </span>
        <div>
          <h2>{merchant.name}</h2>
          <p className="mono">{merchant.merchantId}</p>
        </div>
      </div>

      <div className="stats">
        <div>
          <strong>₹{data.summary.total}</strong>
          <span>Taken</span>
        </div>
        <div>
          <strong>{data.summary.count}</strong>
          <span>{data.summary.count === 1 ? 'Payment' : 'Payments'}</span>
        </div>
      </div>

      <section className="panel-block">
        <div className="block-head">
          <h3>Settlement</h3>
          <p>Where this shop&apos;s takings go, and how often.</p>
        </div>

        <div className="settings">
          <SettingRow
            label="Settlement account"
            note="Where takings are paid out"
            value="Not linked"
            soon
          />
          <SettingRow
            label="Payout schedule"
            note="How often the balance is released"
            value="Not set"
            soon
          />
          <SettingRow
            label="Business details"
            note="Legal name and GSTIN for invoices"
            value="Not added"
            soon
          />
          <SettingRow
            label="Terminal"
            note="Stamped on every payment this shop takes"
            value={merchant.merchantId}
          />
        </div>

        <p className="note">
          Settlement is not wired up yet, so nothing is paid out and no account
          is linked. Payments run in Razorpay test mode — the amounts below are
          real records of test transactions, not money that moved.
        </p>
      </section>

      <section className="panel-block">
        <div className="block-head">
          <h3>Payment history</h3>
          <p>Tap any payment to reprint its receipt.</p>
        </div>

        {data.transactions.length === 0 ? (
          <p className="note">No payments yet.</p>
        ) : (
          <div className="ledger">
            {data.transactions.map((t) => (
              <button
                key={t.id}
                type="button"
                className="ledger-row ledger-row-action"
                onClick={() => setReceipt(t)}
              >
                <div>
                  <strong>{t.customer}</strong>
                  <span className="muted">
                    {new Date(t.at).toLocaleString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {t.matchScore != null && ` · match ${t.matchScore.toFixed(3)}`}
                  </span>
                </div>
                <div className="ledger-amount">
                  ₹{t.amount}
                  <span className={`tag tag-${t.status}`}>{t.status}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {stats && (
        <p className="note">
          {stats.enrolledCustomers} customers enrolled across the system. Every
          payment is matched against all of them — nobody identifies themselves
          first.
        </p>
      )}

      <button className="btn btn-primary" onClick={onBack}>
        Back to till
      </button>
    </div>
  );
}
