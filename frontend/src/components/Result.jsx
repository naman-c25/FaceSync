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

export function Result({ result, onAgain, onEnrol }) {
  // `confirmed` is only absent on outcomes that never reached the PIN at all.
  const refused = result.decision === 'matched' && result.confirmed === false;
  const outcome = refused
    ? OUTCOMES.refused
    : (OUTCOMES[result.decision] ?? OUTCOMES.no_match);
  const { top, runnerUp, margin } = result.confidence;

  return (
    <div className="screen">
      <div className="card verdict">
        <div className={`badge ${outcome.tone}`}>{outcome.icon}</div>
        <h2>{outcome.title(result)}</h2>
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

      <p className="note">
        Compared against <strong>{result.gallerySize}</strong>{' '}
        {result.gallerySize === 1 ? 'enrolled face' : 'enrolled faces'}. The gap
        between the best match and the runner-up is what decides whether the
        system is confident or merely guessing.
      </p>

      <div className="stack">
        <button className="btn btn-primary" onClick={onAgain}>
          Try again
        </button>
        {result.decision !== 'matched' && (
          <button className="btn btn-secondary" onClick={onEnrol}>
            Register my face
          </button>
        )}
      </div>
    </div>
  );
}
