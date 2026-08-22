import { useCallback, useEffect, useState } from 'react';

import { merchantApi, tokenStore } from './api.js';
import { Till } from './Till.jsx';

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
        <div className="wordmark">
          <span className="dot" />
          FacePay <span className="muted">· till</span>
        </div>
        {merchant && (
          <button
            className="link-button"
            onClick={() => setView(view === 'till' ? 'history' : 'till')}
          >
            {view === 'till' ? 'Takings' : 'Till'}
          </button>
        )}
      </header>

      {!merchant ? (
        <SignIn onSignedIn={setMerchant} />
      ) : view === 'till' ? (
        <Till merchant={merchant} onSignOut={signOut} />
      ) : (
        <History merchant={merchant} onBack={() => setView('till')} />
      )}

      <footer>Prototype — Razorpay hackathon. Test mode, no real money.</footer>
    </div>
  );
}

function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await merchantApi.login(email.trim(), password));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="stack">
        <h1>Merchant sign in</h1>
        <p className="lede">
          This terminal takes payments from customers' faces. Accounts are
          issued, not self-registered.
        </p>
      </div>

      <form className="card stack" onSubmit={submit}>
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
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="note bad">{error}</p>}
      </form>
    </div>
  );
}

function History({ merchant, onBack }) {
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

  return (
    <div className="screen">
      <div className="stack">
        <h1>{merchant.name}</h1>
        <p className="lede">
          ₹{data.summary.total} across {data.summary.count}{' '}
          {data.summary.count === 1 ? 'payment' : 'payments'}.
        </p>
      </div>

      {stats && (
        <p className="note">
          {stats.enrolledCustomers} customers enrolled across the system. Every
          payment is matched against all of them — nobody identifies themselves
          first.
        </p>
      )}

      {data.transactions.length === 0 ? (
        <p className="note">No payments yet.</p>
      ) : (
        <div className="ledger">
          {data.transactions.map((t) => (
            <div key={t.id} className="ledger-row">
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
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-primary" onClick={onBack}>
        Back to till
      </button>
    </div>
  );
}
