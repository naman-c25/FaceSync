"""Liveness detection — is there a real person in front of the camera?

This runs *before* recognition, deliberately. Matching a face costs an
embedding pass over a 512-dimension model; confirming the frame is not a
printed photo costs some arithmetic on landmarks. Doing the cheap check first
means a spoof attempt never reaches the expensive stage.

The defence is a randomised challenge. Eye-aspect-ratio alone catches a static
photo, but not a replayed video of the real user blinking. Since the service
picks a different action sequence every session and the user has seconds to
perform it, pre-recorded footage cannot satisfy a prompt it has never seen.

Known limits, stated honestly: a high-quality 3D mask with cut-out eyes could
in principle satisfy both EAR and gaze, and an attacker who injects frames
below the camera driver bypasses this layer entirely. Both need hardware
attestation or depth sensing to address and are out of scope here.
"""

import secrets
import time
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from config import settings

# NOSE_TIP is a stable point for tracking whether the head moves at all across
# a session. It lives in face_detection with the other landmark indices.
from face_detection import NOSE_TIP, FaceGeometry


class ActionType(str, Enum):
    """Named from the *user's* point of view, which is how the prompt reads."""

    BLINK = "blink"
    LOOK_LEFT = "look_left"
    LOOK_RIGHT = "look_right"


class LivenessStatus(str, Enum):
    IN_PROGRESS = "in_progress"
    PASSED = "passed"
    FAILED = "failed"


# Mapping from a user-facing direction to the image-space gaze ratio that
# proves it. An unmirrored frame puts the subject's left on the image's right,
# so looking left drives the ratio *up*. This table is the single place that
# inversion is encoded — `face_detection` already folded the mirror flag in.
GAZE_LEFT_IS_HIGH_RATIO = True

PROMPTS = {
    ActionType.BLINK: "Blink {count} times",
    ActionType.LOOK_LEFT: "Look to your left",
    ActionType.LOOK_RIGHT: "Look to your right",
}


@dataclass(frozen=True)
class ChallengeStep:
    action: ActionType
    count: int = 1

    @property
    def prompt(self) -> str:
        return PROMPTS[self.action].format(count=self.count)


@dataclass(frozen=True)
class FrameOutcome:
    """What the caller learns after submitting one frame."""

    status: LivenessStatus
    prompt: str | None
    step_index: int
    total_steps: int
    step_progress: float  # 0.0-1.0 through the current action
    failure_reason: str | None = None


@dataclass
class LivenessSignals:
    """Everything measured during a session, for the audit log.

    These are what make threshold tuning possible after the fact: without the
    recorded EAR range and gaze extremes there is no way to tell a genuine
    rejection from a badly-set threshold.
    """

    frames_processed: int = 0
    frames_without_face: int = 0
    frames_ear_unusable: int = 0
    # Frames discarded for holding two faces of comparable size. Separates "the
    # camera could not see you" from "it could not tell which of you it was",
    # which look identical from the outside and need opposite advice.
    frames_crowded: int = 0
    blinks_detected: int = 0
    longest_blink_ms: float = 0.0
    ear_min: float | None = None
    ear_max: float | None = None
    ear_open_baseline: float | None = None
    ear_threshold_used: float | None = None
    gaze_min: float | None = None
    gaze_max: float | None = None
    yaw_min: float | None = None
    yaw_max: float | None = None
    head_motion_px: float = 0.0
    elapsed_seconds: float = 0.0
    effective_fps: float | None = None

    # Per-step evidence for look challenges. Session-wide gaze/yaw ranges were
    # not enough to explain a wrong-direction pass: they say how far the head
    # moved but not from where, or which way relative to what was asked. These
    # three make a failed report readable without guessing.
    #
    # `baseline_retries` counts windows thrown away for not being still, which
    # is what tells you a person never settles rather than never moves.
    # Passive-mode evidence. `passive_motion_px` is the largest frame-to-
    # frame movement of the face centre, which separates a live capture
    # from one image repeated -- not from a photograph someone is holding.
    passive_frames: int = 0
    passive_motion_px: float = 0.0

    baseline_retries: int = 0
    baselines_locked: list = field(default_factory=list)
    step_shifts: list = field(default_factory=list)


def generate_challenge(steps: int | None = None) -> list[ChallengeStep]:
    """Build a fresh randomised action sequence.

    Uses `secrets` rather than `random`: this is a security control, and a
    predictable sequence would let an attacker pre-record the right video.

    Consecutive duplicate actions are avoided — "look left, look left" is
    ambiguous to perform and impossible to score, since the second one has no
    distinguishable start.
    """
    # Passive mode asks for nothing, so there is nothing to randomise. The
    # session still exists and still watches -- see `_advance_passive`.
    if steps is None and settings.liveness_mode == "passive":
        return []

    steps = settings.challenge_steps if steps is None else steps

    sequence: list[ChallengeStep] = []
    previous: ActionType | None = None

    for _ in range(steps):
        choices = [a for a in ActionType if a is not previous]
        action = choices[secrets.randbelow(len(choices))]

        # The blink count used to vary between two and three for extra entropy.
        # Three proved too many in practice: a blink is a ~250ms event, and at
        # the frame rates a browser achieves over a network each one is easy to
        # sample straight past, so asking for three failed sessions that two
        # would have passed. The entropy that matters is in the step sequence.
        count = settings.blinks_required if action is ActionType.BLINK else 1

        sequence.append(ChallengeStep(action=action, count=count))
        previous = action

    return sequence


class LivenessSession:
    """Tracks one user's progress through a challenge, frame by frame.

    Deliberately a plain object with no I/O so it can be unit-tested by feeding
    it synthetic `FaceGeometry` values — no camera, no model, no HTTP.
    """

    def __init__(
        self, session_id: str, challenge: list[ChallengeStep] | None = None
    ) -> None:
        self.session_id = session_id
        self.challenge = challenge if challenge is not None else generate_challenge()
        self.status = LivenessStatus.IN_PROGRESS
        self.failure_reason: str | None = None
        self.signals = LivenessSignals()

        self.step_index = 0

        # Anchored to the first frame's capture time, not to when this object
        # was built. Frames carry their own timestamps so that batching does
        # not distort the blink window, which means the challenge clock is the
        # camera's, and mixing it with a server clock would make every elapsed
        # figure meaningless. Session expiry is a separate concern and stays on
        # the server clock, in session_store.
        self._started_at: float | None = None
        self._last_frame_at: float | None = None

        self._consecutive_missing = 0
        self._closed_since: float | None = None
        self._blinks_this_step = 0
        self._gaze_held_since: float | None = None
        self._baseline: tuple[float, float] | None = None
        self._baseline_samples: list[tuple[float, float]] = []
        self._ear_open: float | None = None
        self._ear_baseline_samples: list[float] = []
        self._nose_track: list[np.ndarray] = []
        self._passive_last_centre: np.ndarray | None = None

    # -- public API ----------------------------------------------------

    @property
    def current_step(self) -> ChallengeStep | None:
        if self.step_index >= len(self.challenge):
            return None
        return self.challenge[self.step_index]

    PASSIVE_PROMPT = "Hold still"

    @property
    def prompt(self) -> str | None:
        step = self.current_step
        if step:
            return step.prompt
        # Passive sessions have no steps, but the kiosk still needs a line to
        # show while it watches.
        if not self.challenge:
            return self.PASSIVE_PROMPT
        return None

    def outcome(self) -> FrameOutcome:
        """Current progress, without consuming a frame."""
        return self._outcome()

    def submit_frame(
        self, geometry: FaceGeometry | None, now: float | None = None
    ) -> FrameOutcome:
        """Advance the state machine by one frame.

        `now` exists so tests can drive the clock. Blink and gaze thresholds
        are measured in milliseconds rather than frames, and synthetic frames
        fed in a tight loop would otherwise all land at the same instant.
        """
        if self.status is not LivenessStatus.IN_PROGRESS:
            return self._outcome()

        now = time.monotonic() if now is None else now
        if self._started_at is None:
            self._started_at = now
        self._last_frame_at = now

        self.signals.frames_processed += 1
        self.signals.elapsed_seconds = round(now - self._started_at, 3)

        # Reported so a failed blink challenge can be read against the rate it
        # was sampled at. Below roughly 8fps a blink starts falling between
        # frames, and that is a capture problem rather than a threshold one.
        if self.signals.elapsed_seconds > 0:
            self.signals.effective_fps = round(
                self.signals.frames_processed / self.signals.elapsed_seconds, 1
            )

        if self._budget_exhausted():
            return self._outcome()

        if geometry is None:
            return self._handle_missing_face()

        self._consecutive_missing = 0
        self._record_signals(geometry)

        if not self.challenge:
            return self._advance_passive(geometry, now)

        step = self.current_step
        if step is None:
            if self._too_crowded():
                return self._finish(LivenessStatus.FAILED, "too_many_faces")
            return self._finish(LivenessStatus.PASSED)

        completed = (
            self._advance_blink(step, geometry, now)
            if step.action is ActionType.BLINK
            else self._advance_gaze(step, geometry, now)
        )

        if completed:
            self._begin_next_step()

        return self._outcome()

    def _advance_passive(self, geometry: FaceGeometry, now: float) -> FrameOutcome:
        """Watch a still face for a moment, with nothing asked of the person.

        What this checks, stated plainly so that nothing downstream describes
        it as more than it is:

        - a face is present, and only one of them is close enough in size to be
          the subject, which `analyse` and the dominance rule already settled
        - it stays present for `passive_scan_seconds`, so the decision rests on
          a sample of someone standing there rather than one instant
        - the frames are not identical to each other

        That last one catches a static image fed straight into the pipeline,
        where every frame is the same bytes. It does not catch a photograph
        held up to a camera: that shakes in the hand, the sensor noise differs
        frame to frame, and it will pass this comfortably.

        So this is not presentation attack detection. A photograph reaches the
        embedding stage and matches, and the PIN is then the only thing between
        an attacker holding your picture and a payment. The challenge mode is
        what makes the face a factor in its own right; this trades that for
        speed. Whoever turns it on should know which of the two they have.
        """
        # Landmark positions never repeat exactly on a real camera -- sensor
        # noise alone moves them. Identical frames mean one image, copied.
        centre = geometry.landmarks.mean(axis=0)
        if self._passive_last_centre is not None:
            drift = float(np.linalg.norm(centre - self._passive_last_centre))
            self.signals.passive_motion_px = round(
                max(self.signals.passive_motion_px, drift), 3
            )
        self._passive_last_centre = centre

        self.signals.passive_frames += 1

        long_enough = self.signals.elapsed_seconds >= settings.passive_scan_seconds
        enough_frames = self.signals.passive_frames >= settings.passive_min_frames
        moved_at_all = self.signals.passive_motion_px > 0.0

        if long_enough and enough_frames and moved_at_all:
            if self._too_crowded():
                return self._finish(LivenessStatus.FAILED, "too_many_faces")
            return self._finish(LivenessStatus.PASSED)

        return self._outcome()

    # -- budget and failure handling -----------------------------------

    def _too_crowded(self) -> bool:
        """Whether this scan spent too much of itself unable to tell who is who.

        Checked at the end rather than per frame, because one or two crowded
        frames mean somebody walked past and a scan that survives them is
        better than one that does not.
        """
        seen = self.signals.frames_processed
        if seen < 5:
            return False
        return self.signals.frames_crowded / seen > settings.max_crowded_frame_ratio

    def _budget_exhausted(self) -> bool:
        """A live person finishes in seconds; a long session means fiddling."""
        if self.signals.elapsed_seconds > settings.liveness_timeout_seconds:
            self._finish(LivenessStatus.FAILED, "challenge_timeout")
            return True
        if self.signals.frames_processed > settings.liveness_max_frames:
            self._finish(LivenessStatus.FAILED, "frame_budget_exceeded")
            return True
        return False

    def _handle_missing_face(self) -> FrameOutcome:
        self.signals.frames_without_face += 1
        self._consecutive_missing += 1

        # A gap resets the step's progress *and* its baseline: a "hold"
        # interrupted by the face vanishing is not a hold, and a rest position
        # measured before the gap says nothing about whatever is in front of
        # the lens after it.
        self._gaze_held_since = None
        self._baseline = None
        self._baseline_samples = []

        if self._consecutive_missing >= settings.max_consecutive_missing_face:
            # A frame dropped for holding two comparable faces is not a frame
            # with nobody in it, and telling someone their face left the frame
            # while they are standing directly in front of the camera is worse
            # than saying nothing. The two need opposite advice -- move back
            # into shot, versus ask the person behind you to step aside -- so
            # whichever cause dominated the run is the one reported.
            crowded = self.signals.frames_crowded > self.signals.frames_without_face / 2
            self._finish(
                LivenessStatus.FAILED,
                "too_many_faces" if crowded else "face_lost",
            )
        return self._outcome()

    # -- per-action progress -------------------------------------------

    def _blink_threshold(self) -> float:
        """The EAR below which this person's eye counts as closed.

        Scaled to their own open-eye value once it has been measured. Eye shape
        varies enough between people that a fixed number is either unreachable
        for narrow eyes or trivially crossed by wide ones — but the *ratio* of
        blink floor to open eye is nearly constant, so scaling transfers where
        a constant does not.

        Falls back to the fixed threshold until the baseline exists.
        """
        if self._ear_open is None:
            return settings.ear_threshold
        return settings.ear_closed_fraction * self._ear_open

    def _advance_blink(
        self, step: ChallengeStep, geometry: FaceGeometry, now: float
    ) -> bool:
        """Count blinks by watching EAR fall and come back up.

        A blink is scored on the *rising* edge, not while the eyes are shut,
        because the closure has to end for it to have been a blink at all.
        That distinction is what separates a real blink from a photo of
        someone with their eyes closed, which would otherwise sit under the
        threshold forever and count as an endless string of blinks.

        Frames where the head is too turned are skipped rather than scored. On
        those, EAR is measuring foreshortening rather than eyelids, and a value
        that drifts under the threshold because the face rotated would be
        counted as a blink that never happened.
        """
        if not geometry.ear_is_meaningful:
            # Not a blink and not evidence against one — drop the frame and
            # abandon any closure in progress, since its end cannot be seen.
            self._closed_since = None
            self.signals.frames_ear_unusable += 1
            return False

        if self._ear_open is None:
            self._ear_baseline_samples.append(geometry.ear)
            if len(self._ear_baseline_samples) < settings.ear_baseline_frames:
                return False

            self._ear_open = max(self._ear_baseline_samples)
            self.signals.ear_open_baseline = round(self._ear_open, 4)
            self.signals.ear_threshold_used = round(self._blink_threshold(), 4)
            return False

        if geometry.ear < self._blink_threshold():
            if self._closed_since is None:
                self._closed_since = now
            return False

        closed_since, self._closed_since = self._closed_since, None
        if closed_since is None:
            return False  # the eyes were already open

        # Measured from the first closed frame to the first open one. It
        # slightly overstates the closure, since it began some time before that
        # first frame caught it, but that error shrinks as the frame rate rises
        # and never turns noise into a blink.
        closed_ms = (now - closed_since) * 1000.0

        if settings.blink_min_ms <= closed_ms <= settings.blink_max_ms:
            self._blinks_this_step += 1
            self.signals.blinks_detected += 1
            self.signals.longest_blink_ms = max(
                self.signals.longest_blink_ms, round(closed_ms, 1)
            )

        return self._blinks_this_step >= step.count

    def _advance_gaze(
        self, step: ChallengeStep, geometry: FaceGeometry, now: float
    ) -> bool:
        """Score a look step on movement away from the rest position.

        The first few frames of the step establish where this person's head and
        eyes sit at rest. After that the step can be answered either way, since
        told to "look left" some people swivel their eyes and others turn their
        head, and demanding one of them would reject people who did exactly
        what the prompt asked:

        - the head is still and the eyes swivel, or
        - the head turns.

        Which of the two is read is decided by the head, not by taking the
        better of them. The iris ratio measures where the eyes point *within the
        head*, so it only describes intent while the head is holding still —
        once the head turns it describes counter-rotation instead. Accepting
        either signal independently was a live bug; see the comment on the
        decision below.

        Measuring movement rather than absolute position is what keeps a still
        photo from satisfying this. Someone photographed with their head turned
        sits permanently past any absolute threshold; what they cannot do is
        turn further on cue. (Physically rotating a printed photo mid-challenge
        would move the yaw — but a challenge sequence also contains a blink
        step, which no photo answers.)

        A single frame past the delta is as likely to be landmark jitter, or a
        glance at something in the shop, as a response to the prompt — hence
        the hold.
        """
        if self._baseline is None:
            self._baseline_samples.append((geometry.gaze_horizontal, geometry.head_yaw))

            # A sliding window, not the first N frames. The start of a look step
            # is the *worst* moment to assume the head is at rest: the previous
            # step just turned it and it is on its way back. Averaging over a
            # head in motion records a position it was passing through, and the
            # remainder of that return then reads as deliberate movement away
            # from rest — so whichever way the head already happened to be
            # travelling satisfied the next prompt, whatever the person did.
            #
            # Dropping the oldest sample and waiting means the baseline is only
            # ever taken from a head that has actually stopped.
            if len(self._baseline_samples) > settings.baseline_frames:
                self._baseline_samples.pop(0)

            if len(self._baseline_samples) < settings.baseline_frames:
                return False

            gazes = [g for g, _ in self._baseline_samples]
            yaws = [y for _, y in self._baseline_samples]

            if (
                max(gazes) - min(gazes) > settings.baseline_stillness
                or max(yaws) - min(yaws) > settings.baseline_stillness
            ):
                self.signals.baseline_retries += 1
                return False

            count = len(self._baseline_samples)
            self._baseline = (sum(gazes) / count, sum(yaws) / count)
            self.signals.baselines_locked.append(
                (round(self._baseline[0], 4), round(self._baseline[1], 4))
            )
            return False

        gaze_rest, yaw_rest = self._baseline
        gaze_shift = geometry.gaze_horizontal - gaze_rest
        yaw_shift = geometry.head_yaw - yaw_rest

        # How far the head has moved, before the direction mapping is applied.
        # The gate below asks "is the head turning at all", which is a question
        # about magnitude and must not depend on which way the prompt asked.
        head_movement = abs(yaw_shift)

        # LOOK_LEFT is the user's left, which is the image's right, so both
        # signals shift upward. GAZE_LEFT_IS_HIGH_RATIO records that mapping.
        looking_left = step.action is ActionType.LOOK_LEFT
        if looking_left != GAZE_LEFT_IS_HIGH_RATIO:
            gaze_shift, yaw_shift = -gaze_shift, -yaw_shift

        # One signal decides, chosen by whether the head is moving -- never
        # both with an `or`.
        #
        # Reading them independently was a real hole, found at a live kiosk:
        # prompted to look one way and turning the other, the challenge passed.
        # The two signals are not independent. Someone turning their head while
        # still watching the screen counter-rotates their eyes to stay on the
        # camera, which slides the iris toward the opposite eye corner -- so one
        # movement produces a yaw and a gaze shift with *opposite signs*, and
        # `or` let whichever of them happened to point the requested way carry
        # the step. A single turn answered both prompts.
        #
        # So the gaze ratio is only read as intent while the head is still. Once
        # the head is turning, the iris position is describing the counter-
        # rotation rather than where the person is looking, and only the yaw is
        # a statement about direction. This is the same shape as
        # `ear_is_meaningful`: a measurement stops meaning what it usually means
        # once the head moves, so it is gated rather than trusted.
        if head_movement >= settings.yaw_still_max:
            satisfied = yaw_shift >= settings.yaw_delta
            carried_by = "yaw"
        else:
            satisfied = gaze_shift >= settings.gaze_delta
            carried_by = "gaze"

        # Signed and relative to the locked baseline, which the session-wide
        # gaze/yaw ranges cannot show. Recorded on the frame that finishes the
        # step, so a passed step says in one line what actually carried it and
        # which way the head really went relative to what was asked.
        if not satisfied:
            self._gaze_held_since = None
            return False

        if self._gaze_held_since is None:
            self._gaze_held_since = now

        held = (now - self._gaze_held_since) * 1000.0 >= settings.gaze_hold_ms
        if held:
            self.signals.step_shifts.append(
                {
                    "step": self.step_index,
                    "asked": step.action.value,
                    "carried_by": carried_by,
                    "gaze_shift": round(gaze_shift, 4),
                    "yaw_shift": round(yaw_shift, 4),
                }
            )
        return held

    def _begin_next_step(self) -> None:
        self.step_index += 1
        self._blinks_this_step = 0
        self._gaze_held_since = None
        self._closed_since = None

        # Each step re-measures rest, because the previous step almost
        # certainly left the head somewhere other than where it started.
        self._baseline = None
        self._baseline_samples = []

        # The open-eye baseline deliberately survives. Unlike head position, a
        # person's eye shape does not change between steps, so re-measuring it
        # would only cost frames and risk landing on a blink.

        if self.step_index >= len(self.challenge):
            self._finish(LivenessStatus.PASSED)

    # -- bookkeeping ----------------------------------------------------

    def _record_signals(self, geometry: FaceGeometry) -> None:
        signals = self.signals

        # EAR is only logged from frames where it means something. Recording it
        # from turned-head frames would fill the audit trail with values that
        # look like impossible blinks and make threshold tuning misleading.
        tracked = [("gaze", geometry.gaze_horizontal), ("yaw", geometry.head_yaw)]
        if geometry.ear_is_meaningful:
            tracked.append(("ear", geometry.ear))

        for name, value in tracked:
            low, high = getattr(signals, f"{name}_min"), getattr(signals, f"{name}_max")
            setattr(signals, f"{name}_min", value if low is None else min(low, value))
            setattr(signals, f"{name}_max", value if high is None else max(high, value))

        # Total drift of the nose tip. A live head is never perfectly still, so
        # a near-zero figure suggests something rigid in front of the lens.
        # Recorded rather than enforced: a hand holding a printed photo shakes
        # enough to clear any threshold worth setting, so this is evidence for
        # analysis, not a gate that would give false confidence.
        nose = geometry.landmarks[NOSE_TIP]
        if self._nose_track:
            signals.head_motion_px = round(
                signals.head_motion_px + float(np.linalg.norm(nose - self._nose_track[-1])),
                2,
            )
        self._nose_track.append(nose)

    def _finish(self, status: LivenessStatus, reason: str | None = None) -> FrameOutcome:
        self.status = status
        self.failure_reason = reason
        return self._outcome()

    def _step_progress(self) -> float:
        step = self.current_step

        # Passive mode has no step, so progress is how far through the scan
        # window it is. The kiosk draws this as a filling ring, which is the
        # only feedback there is when nothing is being asked of the person.
        if step is None and not self.challenge:
            by_time = self.signals.elapsed_seconds / settings.passive_scan_seconds
            by_frames = self.signals.passive_frames / settings.passive_min_frames
            return min(min(by_time, by_frames), 1.0)

        if step is None:
            return 1.0
        if step.action is ActionType.BLINK:
            return min(self._blinks_this_step / step.count, 1.0)
        if self._gaze_held_since is None or self._last_frame_at is None:
            return 0.0
        held_ms = (self._last_frame_at - self._gaze_held_since) * 1000.0
        return min(held_ms / settings.gaze_hold_ms, 1.0)

    def _outcome(self) -> FrameOutcome:
        return FrameOutcome(
            status=self.status,
            prompt=self.prompt,
            step_index=self.step_index,
            total_steps=len(self.challenge),
            step_progress=round(self._step_progress(), 3),
            failure_reason=self.failure_reason,
        )
