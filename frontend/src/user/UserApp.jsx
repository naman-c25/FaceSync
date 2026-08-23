import { useCallback, useEffect, useState } from 'react';

import { speech } from '../speech.js';
import { userApi, userToken } from './api.js';

/**
 * The customer's own view of their data, from their own phone.
 *
 * Nothing here happens at a till. The point of the system is that paying needs
 * no account at all, so this exists for the questions that arrive afterwards:
 * where did I pay, how much, what is held about me, and how do I get rid of
 * it. A person who never signs in loses nothing.
 */
export function UserApp() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState('overview');

  useEffect(() => {
    if (!userToken.get()) {
      setChecking(false);
      return;
    }
    userApi
      .me()
      .then((profile) => setUser({ userId: profile.userId, displayName: profile.displayName }))
      .catch(() => userToken.clear())
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(() => {
    userApi.signOut();
    setUser(null);
    setView('overview');
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          <span className="dot" />
          FaceSync <span className="muted">· account</span>
        </div>
        {user && (
          <button className="link-button" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>

      {checking ? (
        <div className="screen">
          <div className="card verdict">
            <div className="spinner" />
          </div>
        </div>
      ) : !user ? (
        <SignIn onSignedIn={setUser} />
      ) : (
        <>
          <nav className="tabs">
            {[
              ['overview', 'Overview'],
              ['history', 'Payments'],
              ['security', 'Security'],
              ['privacy', 'Your data'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={`tab${view === key ? ' active' : ''}`}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </nav>

          {view === 'overview' && <Overview />}
          {view === 'history' && <History />}
          {view === 'security' && <Security />}
          {view === 'privacy' && <Privacy onDeleted={signOut} />}
        </>
      )}

      <footer>Prototype — Razorpay hackathon. Not a real payment system.</footer>
    </div>
  );
}

/**
 * Sign in, or attach an account to a face that is already enrolled.
 *
 * Two modes rather than two screens, because from the person's side it is one
 * question: have they been here before. What it is *not* is a way to register
 * a face — that happens at the kiosk, with a camera, and this screen says so
 * rather than leaving someone hunting for a signup that does not exist.
 */
function SignIn({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [fields, setFields] = useState({
    email: '',
    password: '',
    displayName: '',
    pin: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) =>
    setFields((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await userApi.login(fields.email.trim(), fields.password)
          : await userApi.claim({
              email: fields.email.trim(),
              password: fields.password,
              displayName: fields.displayName.trim(),
              pin: fields.pin,
            });
      onSignedIn(result);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="stack">
        <h1>{mode === 'login' ? 'Your account' : 'Set up access'}</h1>
        <p className="lede">
          {mode === 'login'
            ? 'See where you have paid, and what is held about you.'
            : 'Your face is already registered. This adds a way to sign in and read it back.'}
        </p>
      </div>

      <form className="card stack" onSubmit={submit}>
        {mode === 'claim' && (
          <>
            <div className="field">
              <label htmlFor="displayName">The name you registered with</label>
              <input
                id="displayName"
                value={fields.displayName}
                onChange={set('displayName')}
                autoComplete="name"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="pin">Your PIN</label>
              <input
                id="pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={fields.pin}
                onChange={(event) =>
                  setFields((c) => ({
                    ...c,
                    pin: event.target.value.replace(/\D/g, '').slice(0, 4),
                  }))
                }
                required
              />
            </div>
            <p className="note">
              The PIN is what proves this face is yours. A name on its own is
              neither unique nor secret, so it only narrows down which
              registration is meant.
            </p>
          </>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={fields.email}
            onChange={set('email')}
            autoComplete={mode === 'login' ? 'username' : 'email'}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={fields.password}
            onChange={set('password')}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />
        </div>

        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Set up access'}
        </button>
        {error && <p className="note bad">{error}</p>}
      </form>

      <button
        className="btn btn-ghost"
        onClick={() => {
          setMode(mode === 'login' ? 'claim' : 'login');
          setError(null);
        }}
      >
        {mode === 'login'
          ? 'First time here? Set up access'
          : 'I already have an account'}
      </button>

      <p className="note">
        Paying never needs an account. You can register your face and pay
        without giving an email at all — this is only for seeing your own
        records afterwards.
      </p>
    </div>
  );
}

/** Anything that loads once and shows a spinner or an error meanwhile. */
function useLoaded(loader) {
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    loader()
      .then((data) => !cancelled && setState({ data, error: null }))
      .catch((cause) => !cancelled && setState({ data: null, error: cause.message }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

function Loading({ error }) {
  if (error) return <p className="note bad">{error}</p>;
  return (
    <div className="card verdict">
      <div className="spinner" />
    </div>
  );
}

function Overview() {
  const { data, error } = useLoaded(userApi.me);
  if (!data) {
    return (
      <div className="screen">
        <Loading error={error} />
      </div>
    );
  }

  const weak = data.enrollment.meanSimilarity != null && data.enrollment.meanSimilarity < 0.85;

  return (
    <div className="screen">
      <div className="card stack">
        <h2>{data.displayName}</h2>
        <p className="muted">
          Registered{' '}
          {new Date(data.enrolledAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </p>
      </div>

      <dl className="scores">
        <div>
          <dt>Payments</dt>
          <dd>{data.activity.payments}</dd>
        </div>
        <div>
          <dt>Times recognised</dt>
          <dd>{data.activity.recognitions}</dd>
        </div>
        <div>
          <dt>Second factor</dt>
          <dd>{data.security.hasPin ? 'PIN set' : 'None'}</dd>
        </div>
      </dl>

      {data.security.pinLocked && (
        <p className="note bad">
          Your PIN is locked after too many wrong attempts. It unlocks by
          itself, or you can set a new one under Security.
        </p>
      )}

      {weak && (
        <p className="note warn">
          Your registration samples varied more than ideal (
          {data.enrollment.meanSimilarity.toFixed(2)} agreement), which makes
          recognition less reliable at a till. Registering again in steadier
          light would improve it.
        </p>
      )}

      <p className="note">
        You are identified by your face alone — you never give a name or a
        number at a shop. The PIN is how you approve the payment once the face
        has said who you are.
      </p>
    </div>
  );
}

function History() {
  const { data, error } = useLoaded(userApi.transactions);
  if (!data) {
    return (
      <div className="screen">
        <Loading error={error} />
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="stack">
        <h1>₹{data.summary.total}</h1>
        <p className="lede">
          across {data.summary.count} {data.summary.count === 1 ? 'payment' : 'payments'}
        </p>
      </div>

      {data.transactions.length === 0 ? (
        <p className="note">
          Nothing yet. Payments appear here the moment a shop charges your face.
        </p>
      ) : (
        <div className="ledger">
          {data.transactions.map((t) => (
            <div key={t.id} className="ledger-row">
              <div>
                <strong>{t.merchant.name}</strong>
                <span className="muted">
                  {new Date(t.at).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {t.authFactors?.length ? ` · ${t.authFactors.join(' + ')}` : ''}
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
    </div>
  );
}

function Security() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [state, setState] = useState({ error: null, done: false });
  const [busy, setBusy] = useState(false);

  const digits = (setter) => (event) =>
    setter(event.target.value.replace(/\D/g, '').slice(0, 4));

  const matches = next === again;
  const ready = /^\d{4}$/.test(current) && /^\d{4}$/.test(next) && matches;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setState({ error: null, done: false });
    try {
      await userApi.changePin(current, next);
      setState({ error: null, done: true });
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (cause) {
      setState({ error: cause.message, done: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="stack">
        <h1>Security</h1>
        <p className="lede">
          Your face says who you are. The PIN is how you approve a payment, and
          it is the only thing an attacker holding your photograph does not
          have.
        </p>
      </div>

      <form className="card stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="current">Current PIN</label>
          <input id="current" type="password" inputMode="numeric" maxLength={4}
            value={current} onChange={digits(setCurrent)} required />
        </div>
        <div className="field">
          <label htmlFor="next">New PIN</label>
          <input id="next" type="password" inputMode="numeric" maxLength={4}
            value={next} onChange={digits(setNext)} required />
        </div>
        <div className="field">
          <label htmlFor="again">New PIN again</label>
          <input id="again" type="password" inputMode="numeric" maxLength={4}
            value={again} onChange={digits(setAgain)} required />
        </div>

        {next.length === 4 && again.length === 4 && !matches && (
          <p className="note bad">Those two do not match.</p>
        )}

        <button className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Changing…' : 'Change PIN'}
        </button>

        {state.done && <p className="note">PIN changed. Any lockout is cleared.</p>}
        {state.error && <p className="note bad">{state.error}</p>}
      </form>

      <p className="note">
        Avoid a birth year, 1234, or four of the same digit — the server turns
        those away. Four digits is only ten thousand possibilities, so what
        actually protects it is the lockout after three wrong tries, exactly as
        at a cash machine.
      </p>

      <SpeechToggle />
    </div>
  );
}

/** Spoken feedback is on by default; someone who finds it intrusive can stop it. */
function SpeechToggle() {
  const [on, setOn] = useState(speech.enabled);
  if (!speech.available) return null;

  return (
    <div className="card stack">
      <h2>Spoken feedback</h2>
      <p className="muted">
        The kiosk reads prompts and results aloud, so you can follow it while
        looking at the camera rather than the screen.
      </p>
      <button
        className="btn btn-secondary"
        onClick={() => {
          const next = speech.toggle(!on);
          setOn(next);
          if (next) speech.say('Spoken feedback is on.');
        }}
      >
        {on ? 'Turn spoken feedback off' : 'Turn spoken feedback on'}
      </button>
    </div>
  );
}

function Privacy({ onDeleted }) {
  const { data, error } = useLoaded(userApi.me);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!data && !result) {
    return (
      <div className="screen">
        <Loading error={error} />
      </div>
    );
  }

  if (result) {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge">✓</div>
          <h2>Deleted</h2>
          <p className="muted">{result.note}</p>
        </div>
        <button className="btn btn-primary" onClick={onDeleted}>
          Done
        </button>
      </div>
    );
  }

  const armed = confirm === 'DELETE MY FACE DATA' && /^\d{4}$/.test(pin);

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setResult(await userApi.deleteFaceData(pin));
    } catch (cause) {
      setProblem(cause.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="stack">
        <h1>Your data</h1>
        <p className="lede">Everything held about you, and how to remove it.</p>
      </div>

      <div className="card stack">
        <h2>What is stored</h2>
        <ul className="plain-list">
          {data.dataHeld.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="note">
          No photograph of you exists anywhere in the system. What is stored is
          a list of numbers derived from your face, encrypted, and it cannot be
          turned back into a picture.
        </p>
      </div>

      <div className="card stack">
        <h2>Delete your face data</h2>
        <p className="muted">
          This removes your face signature and your PIN, permanently. You would
          have to register from scratch to pay by face again.
        </p>
        <p className="note warn">
          Records of payments you made stay with the shops, as their own
          accounts, no longer linked to you. Deleting those would not be a
          privacy feature — it would be a hole in someone's ledger.
        </p>

        <div className="field">
          <label htmlFor="del-pin">Your PIN</label>
          <input id="del-pin" type="password" inputMode="numeric" maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} />
        </div>
        <div className="field">
          <label htmlFor="del-confirm">
            Type <strong>DELETE MY FACE DATA</strong> to confirm
          </label>
          <input id="del-confirm" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </div>

        <button className="btn btn-danger" disabled={!armed || busy} onClick={remove}>
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
        {problem && <p className="note bad">{problem}</p>}
      </div>
    </div>
  );
}
