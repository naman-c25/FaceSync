import { livenessVelocityRule } from './livenessVelocityRule.js';
import { pinVelocityRule } from './pinVelocityRule.js';
import { spoofBurstRule } from './spoofBurstRule.js';

/**
 * Every rule the engine evaluates. Order is display order, strongest first.
 *
 * Two further rules were specified and deliberately not built:
 *
 *   Rule 2, "many distinct people at one terminal in a short window" — run
 *   against 205 real logs at thresholds of 5, 6 and 8 people, it fired zero
 *   times at every one. There are thirteen enrolled users and no moment when
 *   five of them used the same terminal within ten minutes.
 *
 *   Rule 4, "a spike in ambiguous results" — there is not one `ambiguous`
 *   outcome in the entire log. The margin rule that makes ambiguity rare is
 *   working, which leaves this rule nothing to measure.
 *
 * Both would be code that has never once executed. Shipping them so the count
 * reads "four rules" would be the same dishonesty as training a fraud model on
 * invented fraud, which is the thing this whole approach exists to avoid. They
 * belong here when there is traffic that would trigger them.
 */
export const RULES = [pinVelocityRule, spoofBurstRule, livenessVelocityRule];
