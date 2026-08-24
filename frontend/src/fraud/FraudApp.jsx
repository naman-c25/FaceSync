import { useCallback, useEffect, useState } from 'react';

import { fraudApi } from './api.js';

/**
 * The review screen for flagged patterns.
 *
 * Its job is to be doubted. Every flag opens onto the actual verification-log
 * rows the rule counted, because a number a reviewer cannot check is a number
 * they have to take on faith — and these are heuristics with thresholds that
 * were guessed once and measured afterwards. A dashboard that only showed
 * verdicts would be asking for trust it has not earned.
 *
 * The two review verdicts are deliberately separate. "Cleared" and "confirmed"
 * are the only feedback a threshold will ever get: a rule whose flags are all
 * cleared is a rule tuned too tight, and that is worth being able to see.
 */

const SEVERITY = {
  high_risk: { label: 'High risk', tone: 'sev-high' },
  suspicious: { label: 'Suspicious', tone: 'sev-mid' },
  review: { label: 'Review', tone: 'sev-low' },
};

const OUTCOME_LABEL = {
  pin_failed: 'PIN refused',
  liveness_failed: 'Liveness failed',
  capture_failed: 'Capture failed',
  no_match: 'No match',
  ambiguous: 'Ambiguous',
  matched: 'Matched',
  error: 'Error',
};

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const clock = (value) =>
  value ? new Date(value).toLocaleTimeString(undefined, { timeStyle: 'medium' }) : '—';

function Login({ onIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      onIn(await fraudApi.login(email, password));
    } catch (cause) {
      setProblem(cause.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="screen" onSubmit={submit}>
      <div className="stack">
        <h1>Fraud review</h1>
        <p className="lede">
          Admin accounts only. Flags span every terminal, so a merchant sign-in
          will be refused here.
        </p>
      </div>

      {problem && <p className="note bad">{problem}</p>}

      <label className="field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          autoComplete="username"
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>

      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

function Evidence({ id, onBack, onReviewed }) {
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fraudApi
      .detail(id)
      .then((result) => !cancelled && setData(result))
      .catch((cause) => !cancelled && setProblem(cause.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const decide = async (verdict) => {
    setBusy(true);
    setProblem(null);
    try {
      await (verdict === 'confirm' ? fraudApi.confirm(id) : fraudApi.clear(id));
      onReviewed();
    } catch (cause) {
      setProblem(cause.message);
      setBusy(false);
    }
  };

  if (problem && !data) return <p className="note bad">{problem}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { flag, evidence } = data;
  const severity = SEVERITY[flag.severity] ?? SEVERITY.review;

  return (
    <div className="stack">
      <button className="link-button" onClick={onBack}>
        ← All flags
      </button>

      <div className="card stack">
        <div className="flag-head">
          <span className={`sev ${severity.tone}`}>{severity.label}</span>
          <span className="muted">{flag.rule}</span>
        </div>
        <h2>{flag.description}</h2>
        <dl className="scores">
          <div>
            <dt>Terminal</dt>
            <dd className="mono">{flag.deviceId}</dd>
          </div>
          <div>
            <dt>Merchant</dt>
            <dd>{flag.merchantId ?? '—'}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{flag.count}</dd>
          </div>
        </dl>
        <p className="muted">
          {when(flag.windowStart)} → {when(flag.windowEnd)}
        </p>
        {flag.user ? (
          <p className="note">
            Attributed to <strong>{flag.user.displayName}</strong> — the face had
            already been identified before these attempts, so this rule can say
            who was being targeted.
          </p>
        ) : (
          <p className="note">
            No identity attached. These checks run before identification, so
            there is no record of whose identity was being attempted — naming one
            would mean storing a face signature from every failed attempt.
          </p>
        )}
      </div>

      <h2>The attempts this counted</h2>
      <div className="ledger">
        {evidence.map((row) => (
          <div className="ledger-row" key={row.id}>
            <div>
              <strong>{OUTCOME_LABEL[row.outcome] ?? row.outcome}</strong>
              <span className="muted">
                {row.pinOutcome ?? row.failureReason ?? row.user ?? '—'}
              </span>
            </div>
            <div className="ledger-amount mono">{clock(row.at)}</div>
          </div>
        ))}
      </div>

      {problem && <p className="note bad">{problem}</p>}

      {flag.status === 'open' ? (
        <div className="stack">
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => decide('confirm')}
          >
            Confirm as fraud
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => decide('clear')}
          >
            Dismiss — nothing wrong here
          </button>
        </div>
      ) : (
        <p className="note">
          Marked <strong>{flag.status}</strong> by {flag.reviewedBy} on{' '}
          {when(flag.reviewedAt)}. Reviewing is one-way: reopening would let the
          record of what somebody decided be rewritten.
        </p>
      )}
    </div>
  );
}

function Flags({ onOpen }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('open');
  const [problem, setProblem] = useState(null);

  const load = useCallback(() => {
    fraudApi
      .flags({ status })
      .then(setData)
      .catch((cause) => setProblem(cause.message));
  }, [status]);

  useEffect(load, [load]);

  if (problem) return <p className="note bad">{problem}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <div className="tabs">
        {['open', 'confirmed', 'cleared', 'all'].map((value) => (
          <button
            key={value}
            className={`tab${status === value ? ' active' : ''}`}
            onClick={() => setStatus(value)}
          >
            {value}
          </button>
        ))}
      </div>

      {data.flags.length === 0 ? (
        <div className="card stack">
          <h2>Nothing flagged</h2>
          <p className="muted">
            No pattern has crossed a threshold. That is the expected state — the
            rules exist to catch bursts, and ordinary traffic does not produce
            them.
          </p>
        </div>
      ) : (
        <div className="ledger">
          {data.flags.map((flag) => {
            const severity = SEVERITY[flag.severity] ?? SEVERITY.review;
            return (
              <button
                className="ledger-row ledger-row-action"
                key={flag.id}
                onClick={() => onOpen(flag.id)}
              >
                <div>
                  <strong>{flag.description}</strong>
                  <span className="muted">
                    {flag.deviceId} · {when(flag.raisedAt)}
                    {flag.user ? ` · ${flag.user.displayName}` : ''}
                  </span>
                </div>
                <span className={`sev ${severity.tone}`}>{severity.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* What is actually being watched for, with the numbers. A reviewer
          should be able to see why a flag exists without reading the source,
          and a threshold on screen is a threshold somebody can argue with. */}
      <h2>Rules in force</h2>
      <div className="ledger">
        {data.rules.map((rule) => (
          <div className="ledger-row" key={rule.name}>
            <div>
              <strong>{rule.name}</strong>
              <span className="muted">
                {rule.threshold} in {rule.windowMinutes} minutes, per terminal
                {rule.attributesIdentity ? ' · names the target' : ''}
              </span>
            </div>
            <span className={`sev ${(SEVERITY[rule.severity] ?? SEVERITY.review).tone}`}>
              {(SEVERITY[rule.severity] ?? SEVERITY.review).label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FraudApp() {
  const [signedIn, setSignedIn] = useState(() => fraudApi.hasToken());
  const [openFlag, setOpenFlag] = useState(null);
  // Bumped after a review so the list refetches rather than showing the flag
  // still sitting in the queue it just left.
  const [revision, setRevision] = useState(0);

  const signOut = () => {
    fraudApi.logout();
    setSignedIn(false);
    setOpenFlag(null);
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          <span className="dot" />
          FaceSync · fraud review
        </div>
        {signedIn && (
          <button className="link-button" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>

      {!signedIn ? (
        <Login onIn={() => setSignedIn(true)} />
      ) : (
        <div className="screen">
          {openFlag ? (
            <Evidence
              id={openFlag}
              onBack={() => setOpenFlag(null)}
              onReviewed={() => {
                setOpenFlag(null);
                setRevision((n) => n + 1);
              }}
            />
          ) : (
            <Flags key={revision} onOpen={setOpenFlag} />
          )}
        </div>
      )}

      <footer>
        Rule-based flagging, not a trained model. Thresholds were measured
        against real logs, not chosen.
      </footer>
    </div>
  );
}
