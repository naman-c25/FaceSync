/**
 * Rule 1a — repeated PIN refusals at one terminal.
 *
 * The strongest of the three, and the only one that can name who was targeted.
 * By the time a PIN is being entered the face has already been identified, so
 * a run of refusals is somebody working through digits against a person the
 * system has already agreed they look like. Nothing innocent produces that
 * shape: a real user who mistypes gets it right on the second go, and the
 * account locks on its own after a few.
 *
 * Three in five minutes, because the per-account lockout already covers a
 * single identity — this catches the case the lockout misses, which is one
 * terminal being worked against several identities in turn.
 *
 * Until recently this rule had no data at all. A refused PIN returned a 200
 * and wrote nothing, so the audit trail showed a successful identification
 * followed by silence. `pin_failed` rows exist because of this rule.
 */
export const pinVelocityRule = {
  name: 'pin_velocity',
  severity: 'high_risk',
  windowMs: 5 * 60 * 1000,
  threshold: 3,

  // The only rule that sets a user on the flag. See FraudFlag.matchedUser.
  attributesIdentity: true,

  matches: (log) => log.outcome === 'pin_failed',
  filter: { outcome: 'pin_failed' },

  describe: (count) =>
    `${count} PIN refusals at this terminal within five minutes`,
};
