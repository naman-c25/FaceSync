/**
 * Spoken feedback, using the browser's own speech synthesis.
 *
 * A kiosk is used at arm's length by someone who is looking at a camera rather
 * than at text. "Hold still", "that looked like a photo", "thank you, Naman" --
 * heard rather than read -- is the difference between a person understanding
 * what went wrong and one pressing the button again harder.
 *
 * It also does something the screen cannot: it works for someone who cannot
 * read the prompt, in a language they do not read, or who is standing too far
 * back to see it. That is worth more than it costs, and it costs nothing --
 * `speechSynthesis` is built into the browser, so there is no library, no
 * network call and no key.
 *
 * Everything here degrades to silence. Speech is unavailable in some browsers,
 * blocked until a user gesture in others, and switched off entirely by people
 * who find it intrusive. None of that may affect whether a payment works, so
 * every call is wrapped and nothing here ever throws or returns a promise the
 * caller has to wait on.
 */
const STORAGE_KEY = 'facepay.speech.v1';

const supported =
  typeof window !== 'undefined' && 'speechSynthesis' in window;

function readPreference() {
  try {
    // On by default. Someone who wants silence turns it off once and it stays
    // off; someone who never thinks about it gets the accessible behaviour.
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

let enabled = readPreference();

export const speech = {
  get available() {
    return supported;
  },

  get enabled() {
    return supported && enabled;
  },

  toggle(on) {
    enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // A viewer who blocks storage still gets the change for this session.
    }
    if (!on) this.cancel();
    return enabled;
  },

  /**
   * Say something, replacing whatever was being said.
   *
   * Replacing rather than queueing is deliberate. These are status
   * announcements about a live camera, and a queue would still be reading out
   * "hold still" after the scan had finished and the PIN was being typed.
   */
  say(text, { rate = 1.0 } = {}) {
    if (!this.enabled || !text) return;

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(text));
      utterance.rate = rate;
      utterance.lang = 'en-IN';
      window.speechSynthesis.speak(utterance);
    } catch {
      // Silence is an acceptable outcome; a broken payment is not.
    }
  },

  cancel() {
    if (!supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* as above */
    }
  },
};

/**
 * Say something, but not the same thing twice in a row.
 *
 * The camera loop re-renders many times a second and most of those carry the
 * same status. Announcing every one would be an unbroken stammer, so this
 * remembers the last thing said and stays quiet until it changes.
 */
export function createAnnouncer() {
  let last = null;

  return {
    announce(text, options) {
      if (!text || text === last) return;
      last = text;
      speech.say(text, options);
    },
    reset() {
      last = null;
    },
  };
}

/**
 * The enrollment poses, said rather than read.
 *
 * Keyed by the exact wording the ML service sends, because that is what the
 * screen shows and the two must not disagree about a direction. "Slightly" is
 * dropped: it is a syllable of hedging in a sentence someone is trying to obey
 * while holding still, and nobody turns their head hard when asked to turn it.
 *
 * Anything not listed is spoken as written, so a pose added to
 * `ENROLLMENT_GUIDANCE` is still heard rather than silently skipped.
 */
const POSE_SPEECH = {
  'Look straight at the camera': 'Look straight at the camera.',
  'Turn your head slightly left': 'Turn your head left.',
  'Turn your head slightly right': 'Turn your head right.',
  // Not "chin up", which is encouragement rather than an instruction.
  'Tilt your chin slightly up': 'Tilt your chin up.',
  'Tilt your chin slightly down': 'Tilt your chin down.',
  'Look straight ahead once more': 'Look straight ahead again.',
};

/**
 * What to say for an outcome, which is not always what is written on screen.
 *
 * Spoken text needs to be shorter and more direct: a sentence that reads well
 * takes too long to hear while someone is standing at a counter. And a name is
 * said last, so the useful part arrives even if the listener stops attending.
 */
export const SPOKEN = {
  scanning: 'Look at the camera and hold still.',
  moveCloser: 'Move closer to the camera.',
  noFace: 'I cannot see your face. Centre yourself in the oval.',
  tooManyFaces: 'More than one face is in view. Step closer, alone.',
  livenessFailed: 'That did not look like a live face. Please try again.',
  presentationAttack: 'That looks like a photo, not a real face.',
  notRecognised: 'I do not recognise you. You may need to register.',
  ambiguous: 'I am not certain who you are. Please try again.',
  enterPin: 'Enter your PIN to approve.',
  wrongPin: 'Wrong PIN. Try again.',
  pinLocked: 'Too many wrong PINs. This account is locked.',

  recognised: (name) => `Recognised. ${name}.`,
  paid: (amount, name) => `Paid. ${amount} rupees, ${name}.`,
  registered: (name) => `Registered. Welcome, ${name}.`,
  captureIn: (n) => `Capturing in ${n}`,

  /** An enrollment pose, spoken. Falls back to the written wording. */
  pose: (written) => (written ? (POSE_SPEECH[written] ?? written) : null),
};
