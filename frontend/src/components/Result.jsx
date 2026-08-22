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
    body: 'Identified by face alone. In the full flow this is where the second factor comes in.',
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
  const outcome = OUTCOMES[result.decision] ?? OUTCOMES.no_match;
  const { top, runnerUp, margin } = result.confidence;

  return (
    <div className="screen">
      <div className="card verdict">
        <div className={`badge ${outcome.tone}`}>{outcome.icon}</div>
        <h2>{outcome.title(result)}</h2>
        <p className="muted">{outcome.body}</p>
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
