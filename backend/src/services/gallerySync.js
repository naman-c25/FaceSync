import { randomUUID } from 'node:crypto';

import { mlService } from './mlServiceClient.js';

/**
 * Keeps the ML service's copy of the gallery in step with this one.
 *
 * The problem it solves
 * ---------------------
 * Every match used to ship the whole candidate pool to Python: 5.6MB of base64
 * at two thousand users, 21MB at ten thousand, serialised here and decoded
 * there, once per scan, for vectors that do not change between scans. Measured
 * at N = 10,000 that was about 270ms of transport wrapped around a comparison
 * that takes 0.345ms.
 *
 * So the vectors are pushed once and a scan sends ids instead.
 *
 * How staleness is handled
 * ------------------------
 * Each push gets a fresh random `galleryId`, and every match carries it back.
 * Two independent things have to go wrong for a stale answer:
 *
 *   - This module tracks which ids it has pushed. A pool containing an id it
 *     has not sent triggers a re-push before the match goes out, which is what
 *     covers somebody enrolling and paying moments later.
 *   - Python refuses an id it does not recognise as its own, so a restart of
 *     either process resolves on the next request rather than quietly matching
 *     against a gallery that is missing people.
 *
 * A gallery missing the person standing at the till answers `no_match`, which
 * looks exactly like a stranger. That is the failure this is built to make
 * impossible rather than unlikely.
 *
 * Falling back
 * ------------
 * If a push fails, `reference()` returns null and the caller ships the pool
 * inline as it always did. A sync problem is then a speed problem, not an
 * outage -- which is the only basis on which this was worth adding to a system
 * that already worked.
 */

let galleryId = null;
let syncedIds = new Set();
let inFlight = null;

/** Push the pool to the ML service and remember what was sent. */
async function push(gallery) {
  const id = randomUUID();

  await mlService.loadGallery(
    id,
    gallery.map((entry) => ({
      user_id: entry.user_id,
      embedding_b64: entry.embedding_b64,
    })),
  );

  // Only after the push succeeds. Recording the id first would leave this
  // believing a failed push had landed.
  galleryId = id;
  syncedIds = new Set(gallery.map((entry) => entry.user_id));
  return id;
}

/**
 * The id to quote for this pool, pushing first if anything in it is unknown.
 *
 * Returns null when the push fails, which tells the caller to send the vectors
 * inline instead.
 */
export async function reference(gallery) {
  const known = galleryId !== null && gallery.every((e) => syncedIds.has(e.user_id));
  if (known) return galleryId;

  // Concurrent scans during a cold start would otherwise each push the whole
  // gallery. One push, and the rest wait for it.
  inFlight ??= push(gallery).finally(() => {
    inFlight = null;
  });

  try {
    return await inFlight;
  } catch (cause) {
    console.error(`[gallery] push failed, shipping inline instead: ${cause.message}`);
    return null;
  }
}

/**
 * Forget what was pushed, so the next scan re-syncs.
 *
 * Called where the gallery cache is invalidated -- an enrollment that updates
 * a signature, a deletion -- because both change vectors that Python is
 * holding. New *people* are caught by the id check in `reference`; a changed
 * or removed vector is not, since the id is already known.
 */
export function invalidate() {
  galleryId = null;
  syncedIds = new Set();
}

/**
 * Push the gallery before anyone asks for it.
 *
 * The first scan after a restart otherwise pays for the whole build. That is
 * 1.2 seconds at two thousand users and about 30 at ten thousand -- past the
 * ML timeout, so at that size the first customer after a deploy does not wait,
 * they fail. Doing it at boot moves the cost somewhere nobody is standing.
 *
 * Deliberately never throws. A service that will not start because it could
 * not pre-warm a cache is worse than a slow first scan.
 */
export async function warm(buildPool) {
  const startedAt = Date.now();
  try {
    const { gallery } = await buildPool();
    if (gallery.length === 0) {
      console.log('[gallery] nothing enrolled yet, nothing to warm');
      return;
    }

    const id = await reference(gallery);
    console.log(
      id
        ? `[gallery] warmed ${gallery.length} signatures in ${Date.now() - startedAt}ms`
        : `[gallery] built ${gallery.length} locally in ${Date.now() - startedAt}ms; ` +
            'the ML service did not take them, so scans will ship the pool inline',
    );
  } catch (cause) {
    console.error(`[gallery] warm-up failed, carrying on: ${cause.message}`);
  }
}

/** For tests and diagnostics. */
export function stats() {
  return { galleryId, synced: syncedIds.size };
}
