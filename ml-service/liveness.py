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
from face_detection import FaceGeometry

# Nose tip in MediaPipe's canonical mesh — a stable point for tracking whether
# the head moves at all across a session.
NOSE_TIP = 1


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
    blinks_detected: int = 0
    ear_min: float | None = None
    ear_max: float | None = None
    gaze_min: float | None = None
    gaze_max: float | None = None
    head_motion_px: float = 0.0
    elapsed_seconds: float = 0.0


def generate_challenge(steps: int | None = None) -> list[ChallengeStep]:
    """Build a fresh randomised action sequence.

    Uses `secrets` rather than `random`: this is a security control, and a
    predictable sequence would let an attacker pre-record the right video.

    Consecutive duplicate actions are avoided — "look left, look left" is
    ambiguous to perform and impossible to score, since the second one has no
    distinguishable start.
    """
    steps = settings.challenge_steps if steps is None else steps

    sequence: list[ChallengeStep] = []
    previous: ActionType | None = None

    for _ in range(steps):
        choices = [a for a in ActionType if a is not previous]
        action = choices[secrets.randbelow(len(choices))]

        # Randomising the blink count adds entropy for the cost of one digit
        # in the prompt.
        count = settings.blinks_required if action is ActionType.BLINK else 1
        if action is ActionType.BLINK and secrets.randbelow(2):
            count += 1

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
        self.created_at = time.monotonic()
        self.last_seen_at = self.created_at

        self._consecutive_missing = 0
        self._eyes_closed_run = 0
        self._blinks_this_step = 0
        self._gaze_hold_run = 0
        self._nose_track: list[np.ndarray] = []

    # -- public API ----------------------------------------------------

    @property
    def current_step(self) -> ChallengeStep | None:
        if self.step_index >= len(self.challenge):
            return None
        return self.challenge[self.step_index]

    @property
    def prompt(self) -> str | None:
        step = self.current_step
        return step.prompt if step else None

    def is_expired(self) -> bool:
        return time.monotonic() - self.last_seen_at > settings.session_ttl_seconds

    def outcome(self) -> FrameOutcome:
        """Current progress, without consuming a frame."""
        return self._outcome()

    def submit_frame(self, geometry: FaceGeometry | None) -> FrameOutcome:
        """Advance the state machine by one frame."""
        if self.status is not LivenessStatus.IN_PROGRESS:
            return self._outcome()

        self.last_seen_at = time.monotonic()
        self.signals.frames_processed += 1
        self.signals.elapsed_seconds = round(self.last_seen_at - self.created_at, 3)

        if self._budget_exhausted():
            return self._outcome()

        if geometry is None:
            return self._handle_missing_face()

        self._consecutive_missing = 0
        self._record_signals(geometry)

        step = self.current_step
        if step is None:
            return self._finish(LivenessStatus.PASSED)

        completed = (
            self._advance_blink(step, geometry)
            if step.action is ActionType.BLINK
            else self._advance_gaze(step, geometry)
        )

        if completed:
            self._begin_next_step()

        return self._outcome()

    # -- budget and failure handling -----------------------------------

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

        # A gap resets gaze progress: a "hold" interrupted by the face
        # vanishing is not a hold, and letting it accumulate across the gap
        # would let someone swap what is in front of the lens mid-step.
        self._gaze_hold_run = 0

        if self._consecutive_missing >= settings.max_consecutive_missing_face:
            self._finish(LivenessStatus.FAILED, "face_lost")
        return self._outcome()

    # -- per-action progress -------------------------------------------

    def _advance_blink(self, step: ChallengeStep, geometry: FaceGeometry) -> bool:
        """Count blinks by watching EAR fall and come back up.

        A blink is scored on the *rising* edge, not while the eyes are shut,
        because the closure has to end for it to have been a blink at all.
        That distinction is what separates a real blink from a photo of
        someone with their eyes closed, which would otherwise sit under the
        threshold forever and count as an endless string of blinks.
        """
        if geometry.ear < settings.ear_threshold:
            self._eyes_closed_run += 1
            return False

        closed_for = self._eyes_closed_run
        self._eyes_closed_run = 0

        within_blink_duration = (
            settings.ear_consec_frames <= closed_for <= settings.ear_max_closed_frames
        )
        if within_blink_duration:
            self._blinks_this_step += 1
            self.signals.blinks_detected += 1

        return self._blinks_this_step >= step.count

    def _advance_gaze(self, step: ChallengeStep, geometry: FaceGeometry) -> bool:
        """Require the gaze to be held for several consecutive frames.

        A single frame past the threshold is as likely to be landmark jitter or
        a glance at something in the shop as it is a response to the prompt.
        """
        looking_left = step.action is ActionType.LOOK_LEFT
        wants_high_ratio = looking_left == GAZE_LEFT_IS_HIGH_RATIO

        satisfied = (
            geometry.gaze_horizontal >= settings.gaze_ratio_high
            if wants_high_ratio
            else geometry.gaze_horizontal <= settings.gaze_ratio_low
        )

        self._gaze_hold_run = self._gaze_hold_run + 1 if satisfied else 0
        return self._gaze_hold_run >= settings.gaze_hold_frames

    def _begin_next_step(self) -> None:
        self.step_index += 1
        self._blinks_this_step = 0
        self._gaze_hold_run = 0
        self._eyes_closed_run = 0

        if self.step_index >= len(self.challenge):
            self._finish(LivenessStatus.PASSED)

    # -- bookkeeping ----------------------------------------------------

    def _record_signals(self, geometry: FaceGeometry) -> None:
        signals = self.signals
        signals.ear_min = (
            geometry.ear if signals.ear_min is None else min(signals.ear_min, geometry.ear)
        )
        signals.ear_max = (
            geometry.ear if signals.ear_max is None else max(signals.ear_max, geometry.ear)
        )
        signals.gaze_min = (
            geometry.gaze_horizontal
            if signals.gaze_min is None
            else min(signals.gaze_min, geometry.gaze_horizontal)
        )
        signals.gaze_max = (
            geometry.gaze_horizontal
            if signals.gaze_max is None
            else max(signals.gaze_max, geometry.gaze_horizontal)
        )

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
        if step is None:
            return 1.0
        if step.action is ActionType.BLINK:
            return min(self._blinks_this_step / step.count, 1.0)
        return min(self._gaze_hold_run / settings.gaze_hold_frames, 1.0)

    def _outcome(self) -> FrameOutcome:
        return FrameOutcome(
            status=self.status,
            prompt=self.prompt,
            step_index=self.step_index,
            total_steps=len(self.challenge),
            step_progress=round(self._step_progress(), 3),
            failure_reason=self.failure_reason,
        )
