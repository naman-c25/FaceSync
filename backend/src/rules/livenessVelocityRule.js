/**
 * Rule 1b — a terminal producing a run of liveness failures.
 *
 * Split out from the PIN rule rather than counted alongside it, and the
 * threshold is higher, because the two mean completely different things. A
 * wrong PIN is somebody guessing. A liveness failure is usually just bad
 * light: the most common reason in the log is `face_lost`, which is what a
 * backlit person looks like, not an attacker.
 *
 * The threshold is measured rather than chosen, by `scripts/replayFraudRules.js`
 * over real verification logs that were all our own legitimate testing.
 * Pooling every kind of failure together — the original proposal — fired 34
 * times. Counting only liveness failures, and only the ones that are not
 * deliberate attacks, the numbers over 289 logs are:
 *
 *     threshold 3   6 incidents
 *     threshold 4   2
 *     threshold 5   1     <- shipped
 *     threshold 6   0
 *
 * Six would never misfire and would also never catch anything, which is why it
 * is five. Re-run the script rather than trusting these; the log grows.
 *
 * Once is the honest state of it, not zero: this is the weakest of the three
 * rules and it exists to show a human a pattern, not to accuse anyone. Hence
 * `review`.
 *
 * A threshold nobody measured is a guess with a decimal point in it.
 *
 * Deliberate spoof attempts are excluded and handled by `spoof_burst`, so the
 * two rules divide the liveness failures between them rather than both
 * reporting the same burst.
 */
export const livenessVelocityRule = {
  name: 'liveness_velocity',
  severity: 'review',
  windowMs: 5 * 60 * 1000,
  threshold: 5,

  // Liveness fails before identification runs, so these rows have no user on
  // them and this rule cannot honestly say who was involved.
  attributesIdentity: false,

  // Presentation attacks are liveness failures too, and counting them here as
  // well would raise two flags for one burst -- a `spoof_burst` saying somebody
  // is holding up a photograph and a `liveness_velocity` saying the same
  // attempts happened. The rules partition the failures instead: this one is
  // everything that is *not* an attack, which is the innocent half.
  matches: (log) =>
    log.outcome === 'liveness_failed' &&
    !String(log.liveness?.failureReason ?? '').startsWith('presentation_attack'),

  filter: {
    outcome: 'liveness_failed',
    'liveness.failureReason': { $not: /^presentation_attack/ },
  },

  describe: (count) =>
    `${count} liveness failures at this terminal within five minutes`,
};
