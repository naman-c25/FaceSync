"""Liveness state machine tests.

The state machine takes `FaceGeometry` values, not images, so every scenario
here — including the spoof attempts — is driven by synthetic landmark data.
No camera, no model, no fixtures to record.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import settings
from face_detection import FaceGeometry
from liveness import (
    ActionType,
    ChallengeStep,
    LivenessSession,
    LivenessStatus,
    generate_challenge,
)

EYES_OPEN = 0.31
EYES_SHUT = 0.12
GAZE_CENTRE = 0.50


def geometry(ear: float = EYES_OPEN, gaze: float = GAZE_CENTRE) -> FaceGeometry:
    """A synthetic frame. Landmarks are noise — only EAR and gaze are read."""
    return FaceGeometry(
        landmarks=np.zeros((478, 2), dtype=np.float32),
        ear=ear,
        ear_left=ear,
        ear_right=ear,
        gaze_horizontal=gaze,
        gaze_vertical=0.5,
    )


def feed(session: LivenessSession, frames: list[FaceGeometry | None]) -> None:
    for frame in frames:
        session.submit_frame(frame)


def blink_frames(count: int) -> list[FaceGeometry]:
    """Eyes shut long enough to register, then open again to close the blink."""
    closed = [geometry(ear=EYES_SHUT)] * settings.ear_consec_frames
    opened = [geometry(ear=EYES_OPEN)] * 2
    return (closed + opened) * count


def gaze_frames(ratio: float, count: int | None = None) -> list[FaceGeometry]:
    count = settings.gaze_hold_frames if count is None else count
    return [geometry(gaze=ratio)] * count


# -- blink counting ----------------------------------------------------


def test_blink_challenge_passes_on_required_blinks():
    session = LivenessSession("s1", [ChallengeStep(ActionType.BLINK, count=2)])
    feed(session, blink_frames(2))

    assert session.status is LivenessStatus.PASSED
    assert session.signals.blinks_detected == 2


def test_blink_is_counted_only_when_the_eyes_reopen():
    """A closure still in progress is not yet a blink."""
    session = LivenessSession("s2", [ChallengeStep(ActionType.BLINK, count=1)])
    feed(session, [geometry(ear=EYES_SHUT)] * settings.ear_consec_frames)

    assert session.status is LivenessStatus.IN_PROGRESS
    assert session.signals.blinks_detected == 0


def test_single_frame_dip_is_not_a_blink():
    """Guards against landmark jitter being counted as a blink."""
    session = LivenessSession("s3", [ChallengeStep(ActionType.BLINK, count=1)])
    feed(session, [geometry(ear=EYES_SHUT), geometry(ear=EYES_OPEN)] * 5)

    assert session.signals.blinks_detected == 0
    assert session.status is LivenessStatus.IN_PROGRESS


def test_eyes_held_shut_never_counts_as_a_blink():
    """A photo of someone with closed eyes must not pass as blinking."""
    session = LivenessSession("s4", [ChallengeStep(ActionType.BLINK, count=1)])
    held = settings.ear_max_closed_frames + 3
    feed(session, [geometry(ear=EYES_SHUT)] * held + [geometry(ear=EYES_OPEN)])

    assert session.signals.blinks_detected == 0


# -- gaze challenge ----------------------------------------------------


def test_look_left_passes_on_high_ratio():
    """The subject's left sits at higher x in an unmirrored frame."""
    session = LivenessSession("s5", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, gaze_frames(settings.gaze_ratio_high + 0.05))

    assert session.status is LivenessStatus.PASSED


def test_look_left_is_not_satisfied_by_looking_right():
    """The direction mapping must not be symmetric — this catches an inversion."""
    session = LivenessSession("s6", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, gaze_frames(settings.gaze_ratio_low - 0.05, count=20))

    assert session.status is LivenessStatus.IN_PROGRESS


def test_look_right_passes_on_low_ratio():
    session = LivenessSession("s7", [ChallengeStep(ActionType.LOOK_RIGHT)])
    feed(session, gaze_frames(settings.gaze_ratio_low - 0.05))

    assert session.status is LivenessStatus.PASSED


def test_gaze_must_be_held_not_just_touched():
    session = LivenessSession("s8", [ChallengeStep(ActionType.LOOK_LEFT)])
    held = settings.gaze_ratio_high + 0.05

    # Alternate past-threshold and centred frames so the run never accumulates.
    feed(session, [geometry(gaze=held), geometry(gaze=GAZE_CENTRE)] * 10)

    assert session.status is LivenessStatus.IN_PROGRESS


def test_losing_the_face_resets_gaze_progress():
    """Progress must not survive a gap the attacker could swap something into."""
    session = LivenessSession("s9", [ChallengeStep(ActionType.LOOK_LEFT)])
    held = settings.gaze_ratio_high + 0.05

    feed(session, gaze_frames(held, count=settings.gaze_hold_frames - 1))
    feed(session, [None])
    feed(session, gaze_frames(held, count=settings.gaze_hold_frames - 1))

    assert session.status is LivenessStatus.IN_PROGRESS


# -- spoof scenarios ---------------------------------------------------


def test_static_photo_never_passes():
    """A printed photo holds one EAR and one gaze value forever."""
    session = LivenessSession(
        "spoof1",
        [ChallengeStep(ActionType.BLINK, count=2), ChallengeStep(ActionType.LOOK_LEFT)],
    )
    feed(session, [geometry()] * (settings.liveness_max_frames + 1))

    assert session.status is LivenessStatus.FAILED
    assert session.signals.blinks_detected == 0
    assert session.step_index == 0, "an unchanging frame satisfies no action"


def test_replayed_blink_video_fails_a_gaze_challenge():
    """Footage of the real user blinking cannot answer a prompt it never saw."""
    session = LivenessSession("spoof2", [ChallengeStep(ActionType.LOOK_RIGHT)])
    feed(session, blink_frames(6))

    assert session.status is not LivenessStatus.PASSED


def test_session_fails_when_the_face_leaves():
    session = LivenessSession("s10", [ChallengeStep(ActionType.BLINK)])
    feed(session, [None] * settings.max_consecutive_missing_face)

    assert session.status is LivenessStatus.FAILED
    assert session.failure_reason == "face_lost"


def test_frame_budget_stops_a_brute_force_attempt():
    session = LivenessSession("s11", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, [geometry()] * (settings.liveness_max_frames + 2))

    assert session.status is LivenessStatus.FAILED
    assert session.failure_reason == "frame_budget_exceeded"


# -- multi-step sequencing ---------------------------------------------


def test_steps_are_completed_in_order():
    session = LivenessSession(
        "s12",
        [ChallengeStep(ActionType.LOOK_LEFT), ChallengeStep(ActionType.BLINK, count=1)],
    )

    feed(session, blink_frames(1))
    assert session.step_index == 0, "blinking must not satisfy a gaze step"

    feed(session, gaze_frames(settings.gaze_ratio_high + 0.05))
    assert session.step_index == 1

    feed(session, blink_frames(1))
    assert session.status is LivenessStatus.PASSED


def test_blink_progress_does_not_carry_across_steps():
    session = LivenessSession(
        "s13",
        [ChallengeStep(ActionType.BLINK, count=1), ChallengeStep(ActionType.BLINK, count=2)],
    )
    feed(session, blink_frames(1))
    assert session.step_index == 1

    feed(session, blink_frames(1))
    assert session.status is LivenessStatus.IN_PROGRESS, "second step needs 2 fresh blinks"

    feed(session, blink_frames(1))
    assert session.status is LivenessStatus.PASSED


# -- challenge generation ----------------------------------------------


def test_challenge_has_the_configured_length():
    assert len(generate_challenge()) == settings.challenge_steps
    assert len(generate_challenge(steps=4)) == 4


def test_challenge_never_repeats_an_action_back_to_back():
    for _ in range(200):
        actions = [step.action for step in generate_challenge(steps=5)]
        assert all(a != b for a, b in zip(actions, actions[1:]))


def test_challenges_vary_between_sessions():
    """A fixed sequence would let an attacker pre-record the right response."""
    seen = {
        tuple((s.action, s.count) for s in generate_challenge(steps=3))
        for _ in range(60)
    }
    assert len(seen) > 5


def test_frames_after_a_verdict_do_not_change_it():
    session = LivenessSession("s14", [ChallengeStep(ActionType.BLINK, count=1)])
    feed(session, blink_frames(1))
    assert session.status is LivenessStatus.PASSED

    feed(session, [None] * 50)
    assert session.status is LivenessStatus.PASSED


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
