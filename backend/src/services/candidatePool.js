import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { decryptEmbedding } from './encryption.js';

/**
 * Assemble the set of identities a face will be compared against.
 *
 * This is where the system's answer to "how does 1:N scale" lives. Since the
 * customer presents no identifier, every enrolled user is a potential match —
 * and the system-level false match rate grows roughly as N x per-comparison
 * FMR, so an unbounded pool degrades accuracy as well as speed.
 *
 * The narrowing below never asks the customer for anything. It uses only what
 * the merchant terminal already knows about itself:
 *
 *   region          people who enrolled near this shop
 *   knownMerchants  people who have paid at this shop before
 *   lastSeenAt      people still active at all
 *
 * At demo scale none of it engages and the pool is simply everyone, which is
 * correct for a handful of users. The structure matters because the
 * alternative — asking for a phone number — is the thing this project exists
 * to avoid.
 *
 * Narrowing trades recall for speed, and the trade is not small. Measured
 * against a real gallery: with 2,000 identities enrolled, a customer walking
 * into a shop they had never used before fell outside the narrowed pool at
 * eight out of nine real users, because paying anywhere at all gives you a
 * `knownMerchants` entry and that disqualifies you from the "no locality yet"
 * clause below. Visiting a new shop is not an edge case, it is most customers
 * most of the time — and the symptom is being told to register again by a
 * system you are already registered with.
 *
 * So narrowing is only ever the first tier. `identifyFromSession` widens to
 * the whole gallery when the narrow pool comes back with no match, which is
 * what `narrow: false` is for. Nothing here may reject a customer on its own.
 */
export async function buildCandidatePool({ merchantId, region, narrow = true } = {}) {
  const activeSince = new Date(
    Date.now() - config.CANDIDATE_POOL_ACTIVE_DAYS * 24 * 60 * 60 * 1000,
  );

  const query = {
    status: 'active',
    lastSeenAt: { $gte: activeSince },
  };

  // Narrowing is a scale measure, and it is not allowed to cost correctness.
  // Below this size every active user is a candidate, which is both correct
  // and — at a few hundred vectors — a sub-millisecond comparison anyway.
  const activeCount = await User.countDocuments(query);
  const shouldNarrow = narrow && activeCount > config.CANDIDATE_POOL_NARROW_ABOVE;

  if (shouldNarrow) {
    // Region and merchant history are an *either*, not an *and*: a regular
    // who moved away still shops here, and a local who has never been in
    // before is still local.
    //
    // The third clause is the one that is easy to miss and breaks the system
    // without it. Someone who enrolled an hour ago has no home region and has
    // never paid anywhere, so a pure locality filter excludes them from every
    // pool — and since they can only join `knownMerchants` by being
    // identified, they could never be identified anywhere, ever. New users
    // stay in the pool until they have a locality of their own.
    const locality = [];
    if (region) locality.push({ homeRegion: region });
    if (merchantId) locality.push({ knownMerchants: merchantId });

    if (locality.length > 0) {
      locality.push({ homeRegion: null, knownMerchants: { $size: 0 } });
      query.$or = locality;
    }
  }

  const users = await User.find(query)
    .select('+embedding')
    .sort({ lastSeenAt: -1 })
    .limit(config.CANDIDATE_POOL_MAX)
    .lean();

  const gallery = [];
  const undecryptable = [];

  for (const user of users) {
    try {
      gallery.push({
        user_id: String(user._id),
        embedding_b64: decryptEmbedding(user.embedding).toString('base64'),
      });
    } catch (cause) {
      // One unreadable record must not take down every verification at this
      // terminal. Skip it and surface it — a decryption failure means either a
      // key rotation left records behind or a row was tampered with, and both
      // need a human.
      undecryptable.push({ userId: String(user._id), reason: cause.message });
    }
  }

  return { gallery, undecryptable, narrowed: shouldNarrow, activeCount };
}

/**
 * Record that this user was seen here, so future pools can use it.
 *
 * Deliberately fire-and-forget at the call site: a payment that has already
 * been authorised must not fail because a statistics update did.
 */
export async function recordSighting(userId, { merchantId, region } = {}) {
  const update = { $set: { lastSeenAt: new Date() } };

  if (merchantId) update.$addToSet = { knownMerchants: merchantId };
  if (region) update.$set.homeRegion = region;

  await User.updateOne({ _id: userId }, update);
}
