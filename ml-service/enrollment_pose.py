"""Checking that an enrollment sample is the pose that was asked for.

Why this exists
---------------
The prompts were decorative. `ENROLLMENT_GUIDANCE` was sent once at
`/enroll/start` and never looked at again, and `/enroll/capture` checked
sharpness, face count and anti-spoofing -- nothing about where the head was
pointing. Somebody could stare straight ahead through all five prompts and every
sample would be accepted.

That is not only a UX gap. The whole reason for guided angles is to get pose
variety into the fused signature: five views of one face average into something
that survives a head turned slightly differently at a till. Five samples of the
same pose average into one view recorded five times, which is what the system
was actually storing.

Direction, and the trap in it
-----------------------------
Every signal here is in *image* space, matching the naming convention in
`face_detection.py`. The prompts are in *subject* space -- "turn your head left"
means the person's left, which is the image's right on an unmirrored frame.

Getting that backwards would reject people for doing exactly what was asked,
which is a worse failure than not checking at all. `face_detection.analyse`
already normalises `head_yaw` for `frames_are_mirrored`, so this module works in
one convention: yaw rises as the head turns toward the image's right, and the
subject's left is the image's right.

Tolerances
----------
Deliberately loose. The point is to catch somebody who did not turn at all, or
turned the wrong way -- not to grade the angle. A tight threshold here would
turn enrollment into a game, and the samples that matter are the ones a real
person produces when they are trying.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Pose(str, Enum):
    """The poses `ENROLLMENT_GUIDANCE` asks for."""

    STRAIGHT = "straight"
    LEFT = "left"
    RIGHT = "right"
    CHIN_UP = "chin_up"
    CHIN_DOWN = "chin_down"


# The prompt text the ML service sends, and what each one is actually asking
# for. Keyed by the exact wording so the two cannot drift: a prompt added to
# ENROLLMENT_GUIDANCE without an entry here is not silently unchecked, it is
# unmapped, and `for_prompt` says so by returning None.
PROMPT_POSE = {
    "Look straight at the camera": Pose.STRAIGHT,
    "Turn your head slightly left": Pose.LEFT,
    "Turn your head slightly right": Pose.RIGHT,
    "Tilt your chin slightly up": Pose.CHIN_UP,
    "Tilt your chin slightly down": Pose.CHIN_DOWN,
    "Look straight ahead once more": Pose.STRAIGHT,
}


@dataclass(frozen=True)
class PoseCheck:
    """Whether a frame is the pose that was asked for, and what to say if not."""

    ok: bool
    reason: str | None = None
    measured: float | None = None


def for_prompt(prompt: str | None) -> Pose | None:
    """The pose a prompt is asking for, or None if it is not a pose prompt."""
    return PROMPT_POSE.get(prompt or "")


def check(pose: Pose, *, yaw: float, pitch: float, frontality: float,
          turn: float, tilt: float, straight: float,
          baseline_yaw: float | None = None,
          baseline_pitch: float | None = None) -> PoseCheck:
    """Does this frame show the pose that was asked for?

    `yaw` and `pitch` are the ratios from `face_detection`. Movement is measured
    from the baselines when they are known -- this person's own rest position,
    taken from their "look straight" sample -- and from 0.5 when they are not.

    That distinction is not a refinement. Yaw does sit near 0.5 on a real
    frontal face, but pitch does not: the nose is not midway between the top of
    the forehead and the point of the chin, and one measured face reads 0.60
    while perfectly level. Against a fixed 0.5, "chin down" on that face passes
    without moving and "chin up" needs three times the intended movement. Face
    proportions vary, so the fix is to measure the person rather than pick a
    better constant.

    `turn`, `tilt` and `straight` are the tolerances, passed in rather than read
    from settings so the rule can be tested at values that do not depend on the
    deployment's configuration.

    Three answers, not two. "You did not move" and "you moved the wrong way"
    need different things said to the person, and a single rejection reason
    would leave them repeating whatever they just did.
    """
    if pose is Pose.STRAIGHT:
        if frontality >= straight:
            return PoseCheck(ok=True, measured=frontality)
        return PoseCheck(
            ok=False, reason="pose_not_straight", measured=frontality
        )

    # Left and right.
    #
    # `frames_are_mirrored` is false -- getUserMedia hands over an unmirrored
    # frame and the CSS scaleX(-1) mirrors only the preview -- so the subject's
    # left is the image's right, and turning that way makes the yaw *rise*.
    # `analyse` has already normalised for the mirrored case, so this holds
    # either way.
    if pose in (Pose.LEFT, Pose.RIGHT):
        offset = yaw - (0.5 if baseline_yaw is None else baseline_yaw)
        # How far they moved in the direction that was asked for. Negative
        # means they moved the other way, which is the case worth naming.
        toward = offset if pose is Pose.LEFT else -offset

        if toward >= turn:
            return PoseCheck(ok=True, measured=yaw)

        if toward <= -turn:
            # They did turn, just the wrong way. "Turn the other way" and
            # "turn further" are different instructions, and giving the second
            # one here would have them turning further wrong.
            wrong_way = "turned_right" if pose is Pose.LEFT else "turned_left"
            return PoseCheck(ok=False, reason=wrong_way, measured=yaw)

        return PoseCheck(ok=False, reason="not_turned_enough", measured=yaw)

    # Chin up and down. The ratio *falls* as the chin lifts -- see
    # `head_pitch_ratio` -- so raising the chin is a negative offset. Written
    # out rather than folded into a sign, because this reads backwards and a
    # clever one-liner here is a bug waiting to be introduced.
    offset = pitch - (0.5 if baseline_pitch is None else baseline_pitch)
    toward = -offset if pose is Pose.CHIN_UP else offset

    if toward >= tilt:
        return PoseCheck(ok=True, measured=pitch)

    if toward <= -tilt:
        wrong_way = "chin_down" if pose is Pose.CHIN_UP else "chin_up"
        return PoseCheck(ok=False, reason=wrong_way, measured=pitch)

    return PoseCheck(ok=False, reason="not_tilted_enough", measured=pitch)
