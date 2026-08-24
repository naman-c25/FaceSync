/**
 * What the kiosk shows once identification has run.
 *
 * Three outcomes, and the middle one is the interesting one. `ambiguous` means
 * two enrolled people scored close enough that the system genuinely cannot
 * tell them apart on this frame — so it says so rather than picking the higher
 * number, which would be a coin flip presented as a decision.
 */
const OUTCOMES = {
  matched: {
    icon: '✓',
    tone: '',
    title: (result) => `Welcome, ${result.user.displayName}`,
    body: 'Identified by face and approved by PIN. You presented nothing — no phone, no card, no name.',
  },
  // The same match, reached without a PIN because nothing was being paid for.
  // Saying "approved" here would describe a step that never ran.
  checked: {
    icon: '✓',
    tone: '',
    title: () => 'Yes — you are registered',
    body: 'Recognised as this face, with no PIN asked for and no payment started. The scan itself was the real one: same liveness and anti-spoofing checks a payment runs.',
  },
  // A face that was recognised and then refused at the PIN. Saying "not
  // recognised" here would be wrong twice over: the face *was* recognised, and
  // the person needs to know it was the PIN that stopped them, not the camera.
  refused: {
    icon: '!',
    tone: 'unsure',
    title: (result) => result.user?.displayName ?? 'Recognised',
    body: 'Your face was recognised, but the PIN was not accepted.',
  },
  ambiguous: {
    icon: '?',
    tone: 'unsure',
    title: () => 'Not certain enough',
    body: 'Two enrolled faces scored too close to separate. Rather than guess, the system would ask for the second factor to settle it.',
  },
  no_match: {
    icon: '✕',
    tone: 'fail',
    title: () => 'Not recognised',
    body: 'Nobody enrolled looks like this. If you have registered already, try again in better light.',
  },
};

export function Result({ result, checkOnly = false, onAgain, onEnrol, onPay }) {
  // `confirmed` is only absent on outcomes that never reached the PIN at all.
  const refused = result.decision === 'matched' && result.confirmed === false;
  const checked = checkOnly && result.decision === 'matched';
  const outcome = refused
    ? OUTCOMES.refused
    : checked
      ? OUTCOMES.checked
      : (OUTCOMES[result.decision] ?? OUTCOMES.no_match);
  // Destructuring this directly would throw when a path reaches here without
  // it, and a thrown render is a blank screen with nothing to read -- which is
  // a worse failure than a missing number.
  const { top, runnerUp, margin } = result.confidence ?? {};

  return (
    <div className="screen">
      <div className="card verdict">
        <div className={`badge ${outcome.tone}`}>{outcome.icon}</div>
        <h2>{outcome.title(result)}</h2>
        {checked && (
          <p className="muted">
            Registered as <strong>{result.user.displayName}</strong>.
          </p>
        )}
        <p className="muted">{outcome.body}</p>
        {refused && result.reason && (
          <p className="muted">{result.reason}</p>
        )}
      </div>

      <dl className="scores">
        <div>
          <dt>Best match</dt>
          <dd>{top?.toFixed(3) ?? '—'}</dd>
        </div>
        <div>
          <dt>Runner-up</dt>
          <dd>{runnerUp?.toFixed(3) ?? '—'}</dd>
        </div>
        <div>
          <dt>Gap</dt>
          <dd>{margin?.toFixed(3) ?? '—'}</dd>
        </div>
      </dl>

      {result.gallerySize != null && (
        <p className="note">
          Compared against <strong>{result.gallerySize}</strong>{' '}
          {result.gallerySize === 1 ? 'enrolled face' : 'enrolled faces'}. The
          gap between the best match and the runner-up is what decides whether
          the system is confident or merely guessing.
        </p>
      )}

      <div className="stack">
        {/* Somebody who has just confirmed they are registered is one step from
            paying, so that is the button they get rather than a second copy of
            the check they already ran. */}
        {checked && onPay ? (
          <button className="btn btn-primary" onClick={onPay}>
            Pay with my face
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onAgain}>
            Try again
          </button>
        )}
        {result.decision !== 'matched' && (
          <button className="btn btn-secondary" onClick={onEnrol}>
            Register my face
          </button>
        )}
      </div>
    </div>
  );
}
