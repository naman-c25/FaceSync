import { useCallback, useEffect, useState } from 'react';

import { speech } from '../speech.js';
import { userApi, userToken } from './api.js';
import { Wordmark } from '../components/Wordmark.jsx';
import { Enroll } from '../components/Enroll.jsx';
import { SettingRow } from '../components/SettingRow.jsx';

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
        <Wordmark />
        {user && (
          <button className="header-action" onClick={signOut}>
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
/**
 * Sign in, or sign up.
 *
 * Signing up is three screens rather than one long form, and the split is not
 * cosmetic: the last of them turns on a camera. Asking for a name, an email, a
 * password, a PIN *and* a face at once would put a camera on screen before
 * somebody had decided they were doing this, and consent given at that point
 * is a formality rather than a decision.
 *
 * Signing up still finishes by calling `claim` under the covers — enrolling a
 * face and attaching an email are two operations, and the endpoint that joins
 * them is the same one a standalone "set up access" screen used to use. That
 * screen is gone; anybody who registered at a counter without an email signs
 * up here instead, and the enrollment recognises their existing face and
 * updates it rather than storing a second copy.
 */
function SignIn({ onSignedIn }) {
  // `/user#signup` is where "Register your face" on the landing page points.
  // Dropping somebody on the sign-in tab when they just asked to register is a
  // small thing that reads as the link having gone to the wrong place.
  const [mode, setMode] = useState(() =>
    window.location.hash === '#signup' ? 'signup' : 'login',
  );
  const [step, setStep] = useState('details');
  const [fields, setFields] = useState({
    email: '',
    password: '',
    displayName: '',
    pin: '',
    pinAgain: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Set when the face turned out to be one the system already knew, which is
  // worth stopping on rather than sliding past.
  const [outcome, setOutcome] = useState(null);

  const set = (key) => (event) =>
    setFields((current) => ({ ...current, [key]: event.target.value }));

  const setDigits = (key) => (event) =>
    setFields((current) => ({
      ...current,
      [key]: event.target.value.replace(/\D/g, '').slice(0, 4),
    }));

  const go = (next) => {
    setMode(next);
    setStep('details');
    setError(null);
    if (window.location.hash) {
      // Cleared rather than rewritten: the hash is an entry point, not a
      // record of which tab is open, and a reload should not undo a choice
      // made since.
      window.history.replaceState(null, '', window.location.pathname);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await userApi.login(fields.email.trim(), fields.password));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * What happens after the camera, which is three different things.
   *
   *   new face                    an account is created
   *   known face, no sign-in yet  this email and password are attached to it
   *   known face, already claimed nothing is written; sign in instead
   *
   * The third used to attempt the claim anyway and fail with "no enrolled face
   * matches that name and PIN", which reads as though the scan went wrong when
   * it went perfectly. `hasAccount` comes back from the enrollment, so it can
   * be said plainly before anything else is tried.
   */
  const afterFace = async (enrolled) => {
    if (enrolled.hasAccount) {
      setOutcome({
        kind: 'existing',
        name: enrolled.displayName,
      });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const account = await userApi.claim({
        email: fields.email.trim(),
        password: fields.password,
        // The name on file, not the one just typed. A face that was already
        // registered keeps the name it was registered under, and claiming
        // with the other one would simply not match.
        displayName: enrolled.displayName,
        pin: fields.pin,
      });

      // Signed in either way, but a returning face is told it was recognised.
      // Finding out later that an account already existed under a name you did
      // not type is a worse surprise than being told now.
      if (enrolled.updatedExisting) {
        setOutcome({ kind: 'attached', name: enrolled.displayName, account });
        return;
      }
      onSignedIn(account);
    } catch (cause) {
      setError(cause.message);
      setStep('details');
    } finally {
      setBusy(false);
    }
  };

  // ---- the face was already on file ----
  if (outcome?.kind === 'existing') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge unsure">!</div>
          <h2>This face already has an account</h2>
          <p className="muted">
            It is registered as <strong>{outcome.name}</strong>, with an email
            and password already set.
          </p>
        </div>

        <p className="note">
          Nothing was changed — not the name, not the PIN, and not the email on
          the account. Sign in with the address you used the first time.
        </p>

        <button
          className="btn btn-primary"
          onClick={() => {
            setOutcome(null);
            go('login');
          }}
        >
          Go to sign in
        </button>
      </div>
    );
  }

  if (outcome?.kind === 'attached') {
    return (
      <div className="screen">
        <div className="card verdict">
          <div className="badge">✓</div>
          <h2>Your face was already registered</h2>
          <p className="muted">
            It was on file as <strong>{outcome.name}</strong>, from registering
            at a counter. This email and password are now attached to it, and
            your PIN is the one you just chose.
          </p>
        </div>

        <p className="note">
          Your existing payments are already in the history below — the record
          was updated rather than a second one being created.
        </p>

        <button
          className="btn btn-primary"
          onClick={() => onSignedIn(outcome.account)}
        >
          Continue
        </button>
      </div>
    );
  }

  // ---- signing up: the camera step ----
  if (mode === 'signup' && step === 'face') {
    return (
      <Enroll
        presetName={fields.displayName.trim()}
        presetPin={fields.pin}
        onCancel={() => setStep('pin')}
        onDone={afterFace}
      />
    );
  }

  const pinReady =
    /^\d{4}$/.test(fields.pin) && fields.pin === fields.pinAgain;

  // ---- signing up: choosing a PIN ----
  if (mode === 'signup' && step === 'pin') {
    return (
      <div className="screen">
        <div className="stack">
          <h1>Choose a PIN</h1>
          <p className="lede">
            Four digits. Your face says who you are at the counter; this is what
            approves the payment.
          </p>
        </div>

        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            setStep('face');
          }}
        >
          <div className="field">
            <label htmlFor="pin">PIN</label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={fields.pin}
              onChange={setDigits('pin')}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="pinAgain">PIN again</label>
            <input
              id="pinAgain"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={fields.pinAgain}
              onChange={setDigits('pinAgain')}
              required
            />
          </div>

          {/* Both fields because the input is masked and a typo here is not a
              wasted signup -- it is being locked out at a till three wrong
              attempts later with no idea why. */}
          {fields.pinAgain && !pinReady && (
            <p className="note warn">Those two do not match yet.</p>
          )}

          <button className="btn btn-primary" disabled={!pinReady}>
            Next — scan your face
          </button>
        </form>

        <button className="btn btn-ghost" onClick={() => setStep('details')}>
          Back
        </button>
      </div>
    );
  }

  // ---- signing up: name, email, password ----
  if (mode === 'signup') {
    const detailsReady =
      fields.displayName.trim().length > 0 &&
      fields.email.trim().length > 0 &&
      fields.password.length >= 8;

    return (
      <div className="screen">
        <div className="stack">
          <h1>Create your account</h1>
          <p className="lede">
            Four things: who you are, a way to sign in, a PIN, and your face.
          </p>
        </div>

        <Tabs mode={mode} onChange={go} />

        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            setStep('pin');
          }}
        >
          <div className="field">
            <label htmlFor="displayName">Your name</label>
            <input
              id="displayName"
              value={fields.displayName}
              onChange={set('displayName')}
              autoComplete="name"
              required
            />
            <p className="muted">
              Spoken aloud at the counter when you are recognised, and printed
              on your receipt.
            </p>
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={fields.email}
              onChange={set('email')}
              autoComplete="email"
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
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="muted">At least eight characters.</p>
          </div>

          <button className="btn btn-primary" disabled={!detailsReady}>
            Next — choose a PIN
          </button>
          {error && <p className="note bad">{error}</p>}
        </form>

        <p className="note">
          The email and password are only for reading your own records later.
          Paying never asks for either.
        </p>
      </div>
    );
  }

  // ---- forgotten the password ----
  //
  // Nothing here sends mail, so there is no link to click. The proof is the
  // one this system already holds: the name narrows and the PIN settles it,
  // through the same lockout that guards the PIN at a till. Deliberately not
  // the face -- a face that could take over the account would make the
  // password decorative.
  if (mode === 'forgot') {
    const canReset =
      fields.email.trim() &&
      fields.displayName.trim() &&
      /^\d{4}$/.test(fields.pin) &&
      fields.password.length >= 8;

    return (
      <div className="screen">
        <div className="stack">
          <h1>Set a new password</h1>
          <p className="lede">
            Your PIN proves this account is yours. Three wrong answers and it
            locks, the same as at a counter.
          </p>
        </div>

        <form
          className="card stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              onSignedIn(
                await userApi.resetPassword({
                  email: fields.email.trim(),
                  displayName: fields.displayName.trim(),
                  pin: fields.pin,
                  newPassword: fields.password,
                }),
              );
            } catch (cause) {
              setError(cause.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor="fEmail">Email</label>
            <input
              id="fEmail"
              type="email"
              value={fields.email}
              onChange={set('email')}
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="fName">The name you registered with</label>
            <input
              id="fName"
              value={fields.displayName}
              onChange={set('displayName')}
              autoComplete="name"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="fPin">Your PIN</label>
            <input
              id="fPin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={fields.pin}
              onChange={setDigits('pin')}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="fPass">New password</label>
            <input
              id="fPass"
              type="password"
              value={fields.password}
              onChange={set('password')}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="muted">At least eight characters.</p>
          </div>

          <button className="btn btn-primary" disabled={!canReset || busy}>
            {busy ? 'Working…' : 'Set new password'}
          </button>
          {error && <p className="note bad">{error}</p>}
        </form>

        <button className="btn btn-ghost" onClick={() => go('login')}>
          Back to sign in
        </button>
      </div>
    );
  }

  // ---- signing in ----
  return (
    <div className="screen">
      <div className="stack">
        <h1>Your account</h1>
        <p className="lede">
          See where you have paid, and what is held about you.
        </p>
      </div>

      <Tabs mode={mode} onChange={go} />

      <form className="card stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={fields.email}
            onChange={set('email')}
            autoComplete="username"
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
            autoComplete="current-password"
            minLength={8}
            required
          />
        </div>

        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Working…' : 'Sign in'}
        </button>
        {error && <p className="note bad">{error}</p>}

        <button type="button" className="linkish" onClick={() => go('forgot')}>
          Forgotten your password?
        </button>
      </form>

      <p className="note">
        Paying never needs an account. You can register your face at a counter
        and pay without giving an email at all — this is only for seeing your
        own records afterwards. Signing up here does both at once.
      </p>
    </div>
  );
}

/** Sign in / sign up, the same control the merchant portal uses. */
function Tabs({ mode, onChange }) {
  return (
    <div className="tabs">
      <button
        className={`tab${mode === 'login' ? ' active' : ''}`}
        onClick={() => onChange('login')}
      >
        Sign in
      </button>
      <button
        className={`tab${mode === 'signup' ? ' active' : ''}`}
        onClick={() => onChange('signup')}
      >
        Sign up
      </button>
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

  const weak =
    data.enrollment.meanSimilarity != null && data.enrollment.meanSimilarity < 0.85;

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
            <circle cx="12" cy="8.5" r="3.8" />
            <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
          </svg>
        </span>
        <div>
          <h2>{data.displayName}</h2>
          <p>
            Registered{' '}
            {new Date(data.enrolledAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        </div>
      </div>

      {/* Two figures, not three. "Second factor: PIN set" was there when a PIN
          was optional; it is required at registration now, so the row said the
          same thing for everybody. */}
      <div className="stats">
        <div>
          <strong>{data.activity.payments}</strong>
          <span>Payments</span>
        </div>
        <div>
          <strong>{data.activity.recognitions}</strong>
          <span>Times recognised</span>
        </div>
      </div>

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

      <section className="panel-block">
        <div className="block-head">
          <h3>Payment settings</h3>
          <p>Where the money comes from, and how much may leave at once.</p>
        </div>

        <div className="settings">
          <SettingRow
            label="Bank account"
            note="Where payments are drawn from"
            value="Not linked"
            soon
          />
          <SettingRow
            label="Per-payment limit"
            note="The most a single scan can approve"
            value="Not set"
            soon
          />
          <SettingRow
            label="Daily limit"
            note="Across every shop, in one day"
            value="Not set"
            soon
          />
          <SettingRow
            label="Email receipts"
            note="A copy sent after each payment"
            value="Off"
            soon
          />
        </div>

        <p className="note">
          None of these are wired up yet, so nothing here is enforced and no
          account is linked. Payments run in Razorpay test mode — no real money
          moves either way.
        </p>
      </section>

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
  // Which proof is being offered. Forgetting the PIN used to be a dead end --
  // it could not be changed, and deleting the record needs it too -- so the
  // account password is accepted instead. Not the face: a face that could
  // reset the PIN would leave the PIN protecting nothing.
  const [proof, setProof] = useState('pin');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [state, setState] = useState({ error: null, done: false });
  const [busy, setBusy] = useState(false);

  const byPassword = proof === 'password';

  const digits = (setter) => (event) =>
    setter(event.target.value.replace(/\D/g, '').slice(0, 4));

  const matches = next === again;
  const ready =
    (byPassword ? current.length >= 8 : /^\d{4}$/.test(current)) &&
    /^\d{4}$/.test(next) &&
    matches;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setState({ error: null, done: false });
    try {
      await userApi.changePin(
        byPassword ? { currentPassword: current } : { currentPin: current },
        next,
      );
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
          <label htmlFor="current">
            {byPassword ? 'Your account password' : 'Current PIN'}
          </label>
          {byPassword ? (
            <input
              id="current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          ) : (
            <input id="current" type="password" inputMode="numeric" maxLength={4}
              value={current} onChange={digits(setCurrent)} required />
          )}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setProof(byPassword ? 'pin' : 'password');
              setCurrent('');
              setState({ error: null, done: false });
            }}
          >
            {byPassword
              ? 'I remember my PIN'
              : 'Forgotten your PIN? Use your password instead'}
          </button>
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
