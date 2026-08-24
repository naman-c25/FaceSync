/**
 * A stable identifier for the machine this kiosk or till is running on.
 *
 * Every verification used to be logged as `web-kiosk` or `till` — a label for
 * which *app* was open, not which device it was open on. Fraud rules that
 * group by terminal need the second thing: "five failures at this counter in
 * five minutes" is a signal, while "five failures across every kiosk in the
 * world" is a traffic report.
 *
 * Random and local. It identifies a browser profile on a machine, not a person
 * — there is nothing in it derived from the device or from whoever is standing
 * in front of it, and it never leaves this origin except as an opaque string on
 * the verification log.
 */
const KEY = 'facesync.device.v1';

// Used when storage is unavailable. Generated once per page load rather than
// returning a constant, because a constant would put every private window in
// the world back into a single bucket -- which is the problem this replaces.
let ephemeral = null;

function newId(kind) {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) ??
    Math.random().toString(36).slice(2, 12);
  return `${kind}-${random}`;
}

/**
 * @param {'kiosk' | 'till'} kind which surface is asking
 * @returns {string} a stable id, or a per-load one if storage is blocked
 */
export function deviceId(kind) {
  try {
    const existing = localStorage.getItem(KEY);
    // The kind is part of the id, so a machine that has been both is still one
    // device. Whichever it was first wins, and that is fine -- the point is
    // that it stays the same.
    if (existing) return existing;

    const id = newId(kind);
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    ephemeral ??= newId(`${kind}-tmp`);
    return ephemeral;
  }
}
