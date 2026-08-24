/**
 * Rule 3 — repeated presentation attacks at one terminal.
 *
 * The anti-spoofing models classify a frame as a printed photograph, a screen,
 * or a live face, and a rejection is recorded with which. Unlike a liveness
 * failure, this shape has no innocent explanation — nobody holds a phone screen
 * up to a payment terminal by accident, three times in five minutes.
 *
 * What it deliberately does *not* say is whose identity was being attacked.
 * The original design counted spoof attempts "against one enrolled identity",
 * and that cannot be done on this data: anti-spoofing runs before
 * identification, so all 57 liveness-failure rows in the log carry no user and
 * no embedding. Getting one would mean extracting and storing a face signature
 * from every failed attempt — including from people who never got past the
 * first check and may never have consented to anything.
 *
 * So the flag names the terminal and the window. Somebody is attacking this
 * counter; we are not going to build a biometric record of failed attempts in
 * order to also say who they were pretending to be.
 */
export const spoofBurstRule = {
  name: 'spoof_burst',
  severity: 'suspicious',
  windowMs: 5 * 60 * 1000,
  threshold: 3,

  attributesIdentity: false,

  matches: (log) =>
    log.outcome === 'liveness_failed' &&
    typeof log.liveness?.failureReason === 'string' &&
    log.liveness.failureReason.startsWith('presentation_attack'),

  filter: {
    outcome: 'liveness_failed',
    'liveness.failureReason': /^presentation_attack/,
  },

  describe: (count) =>
    `${count} photo or screen attacks at this terminal within five minutes`,
};
