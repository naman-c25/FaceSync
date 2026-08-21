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
HEAD_SQUARE = 0.50


def geometry(
    ear: float = EYES_OPEN,
    gaze: float = GAZE_CENTRE,
    yaw: float = HEAD_SQUARE,
) -> FaceGeometry:
    """A synthetic frame. Landmarks are noise — only the scalars are read.

    Frontality is derived from yaw exactly as `face_detection.analyse` does it,
    so a test that turns the head far enough gets the same EAR gating that a
    real turned head would.
    """
    return FaceGeometry(
        landmarks=np.zeros((478, 2), dtype=np.float32),
        ear=ear,
        ear_left=ear,
        ear_right=ear,
        gaze_horizontal=gaze,
        gaze_vertical=0.5,
        head_yaw=yaw,
        frontality=max(0.0, 1.0 - 2.0 * abs(yaw - 0.5)),
    )


def feed(session: LivenessSession, frames: list[FaceGeometry | None]) -> None:
    for frame in frames:
        session.submit_frame(frame)


def blink_frames(count: int) -> list[FaceGeometry]:
    """Eyes shut long enough to register, then open again to close the blink."""
    closed = [geometry(ear=EYES_SHUT)] * settings.ear_consec_frames
    opened = [geometry(ear=EYES_OPEN)] * 2
    return (closed + opened) * count


def at_rest(count: int | None = None) -> list[FaceGeometry]:
    """Frames the step uses to learn where this person sits at rest."""
    count = settings.baseline_frames if count is None else count
    return [geometry()] * count


def eye_move_frames(shift: float, count: int | None = None) -> list[FaceGeometry]:
    """Rest, then the eyes swivel by `shift` from it."""
    count = settings.gaze_hold_frames if count is None else count
    return at_rest() + [geometry(gaze=GAZE_CENTRE + shift)] * count


def head_turn_frames(shift: float, count: int | None = None) -> list[FaceGeometry]:
    """Rest, then the head turns by `shift` with the eyes staying centred.

    This is what a head turn looks like to the mesh: the iris keeps its
    position between the eye corners, so the gaze ratio does not move at all.
    """
    count = settings.gaze_hold_frames if count is None else count
    return at_rest() + [geometry(gaze=GAZE_CENTRE, yaw=HEAD_SQUARE + shift)] * count


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


def test_a_turned_head_does_not_manufacture_blinks():
    """The bug a real webcam session exposed.

    EAR divides eyelid height by eye width, and eye width foreshortens as the
    head turns while the height barely does. Turning the head therefore drives
    EAR wherever the geometry happens to take it — a live tool measured an
    "open eye" at 1.414 and a floor at 0.028 purely from head rotation. Those
    frames must not be scored as eyelid movement.
    """
    profile = 0.5 - (settings.min_frontality_for_blink / 2.0) - 0.05

    session = LivenessSession("turned", [ChallengeStep(ActionType.BLINK, count=1)])
    # EAR swinging wildly, but every frame taken at a steep angle.
    feed(
        session,
        [geometry(ear=e, yaw=profile) for e in (0.03, 1.41, 0.03, 1.41) for _ in range(4)],
    )

    assert session.signals.blinks_detected == 0
    assert session.signals.frames_ear_unusable == 16


def test_an_implausible_ear_is_ignored_even_when_frontal():
    """A backstop for whatever the frontality gate misses."""
    session = LivenessSession("impl", [ChallengeStep(ActionType.BLINK, count=1)])
    feed(session, [geometry(ear=2.5), geometry(ear=0.001)] * 6)

    assert session.signals.blinks_detected == 0


def test_a_blink_still_counts_at_a_normal_head_angle():
    """The gate must not be so tight that ordinary head movement blocks blinks."""
    slight = 0.5 + 0.05
    session = LivenessSession("slight", [ChallengeStep(ActionType.BLINK, count=1)])

    closed = [geometry(ear=EYES_SHUT, yaw=slight)] * settings.ear_consec_frames
    feed(session, closed + [geometry(ear=EYES_OPEN, yaw=slight)] * 2)

    assert session.signals.blinks_detected == 1


def test_a_closure_interrupted_by_a_head_turn_is_not_a_blink():
    """The end of the closure has to be seen for it to have been a blink."""
    profile = 0.5 - (settings.min_frontality_for_blink / 2.0) - 0.05
    session = LivenessSession("interrupted", [ChallengeStep(ActionType.BLINK, count=1)])

    feed(session, [geometry(ear=EYES_SHUT)] * settings.ear_consec_frames)
    feed(session, [geometry(ear=EYES_SHUT, yaw=profile)] * 3)
    feed(session, [geometry(ear=EYES_OPEN)] * 3)

    assert session.signals.blinks_detected == 0


def test_ear_signals_are_logged_only_from_usable_frames():
    """Otherwise the audit trail fills with EAR values that cannot be real."""
    profile = 0.5 - (settings.min_frontality_for_blink / 2.0) - 0.05
    session = LivenessSession("log", [ChallengeStep(ActionType.BLINK, count=3)])

    feed(session, [geometry(ear=1.41, yaw=profile)] * 5)
    feed(session, [geometry(ear=EYES_OPEN)] * 5)

    assert session.signals.ear_max == pytest.approx(EYES_OPEN)


def test_eyes_held_shut_never_counts_as_a_blink():
    """A photo of someone with closed eyes must not pass as blinking."""
    session = LivenessSession("s4", [ChallengeStep(ActionType.BLINK, count=1)])
    held = settings.ear_max_closed_frames + 3
    feed(session, [geometry(ear=EYES_SHUT)] * held + [geometry(ear=EYES_OPEN)])

    assert session.signals.blinks_detected == 0


# -- gaze challenge ----------------------------------------------------


def test_look_left_passes_when_the_eyes_move():
    """The subject's left sits at higher x in an unmirrored frame."""
    session = LivenessSession("s5", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, eye_move_frames(+settings.gaze_delta - 0.01))
    assert session.status is LivenessStatus.IN_PROGRESS, "just short must not pass"

    session = LivenessSession("s5a", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, eye_move_frames(+settings.gaze_delta + 0.02))
    assert session.status is LivenessStatus.PASSED


def test_look_left_is_not_satisfied_by_looking_right():
    """The direction mapping must not be symmetric — this catches an inversion."""
    session = LivenessSession("s6", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, eye_move_frames(-settings.gaze_delta - 0.05, count=20))

    assert session.status is LivenessStatus.IN_PROGRESS


def test_look_right_passes_when_the_eyes_move_the_other_way():
    session = LivenessSession("s7", [ChallengeStep(ActionType.LOOK_RIGHT)])
    feed(session, eye_move_frames(-settings.gaze_delta - 0.02))

    assert session.status is LivenessStatus.PASSED


def test_turning_the_head_satisfies_a_look_step():
    """Most people turn their head rather than swivel their eyes.

    A head turn leaves the iris centred between the eye corners, so the gaze
    ratio stays at rest. Requiring eye movement alone would reject someone who
    did exactly what the prompt asked.
    """
    session = LivenessSession("s5b", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, head_turn_frames(+settings.yaw_delta + 0.02))

    assert session.status is LivenessStatus.PASSED


def test_turning_the_head_the_wrong_way_does_not_satisfy_a_look_step():
    session = LivenessSession("s5c", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, head_turn_frames(-settings.yaw_delta - 0.02, count=20))

    assert session.status is LivenessStatus.IN_PROGRESS


def test_a_head_already_turned_at_rest_does_not_pass_on_its_own():
    """The photo attack this whole design exists to stop.

    Someone photographed with their head turned sits permanently past any
    absolute threshold. Scoring movement from a per-step baseline means that
    fixed offset counts for nothing — the pose has to *change* on cue.
    """
    for offset in (+0.25, -0.25):
        session = LivenessSession("s5d", [ChallengeStep(ActionType.LOOK_LEFT)])
        turned = geometry(gaze=GAZE_CENTRE + offset, yaw=HEAD_SQUARE + offset)
        feed(session, [turned] * 40)

        assert session.status is LivenessStatus.IN_PROGRESS, (
            f"a fixed pose offset by {offset} satisfied a look step"
        )


def test_gaze_must_be_held_not_just_touched():
    session = LivenessSession("s8", [ChallengeStep(ActionType.LOOK_LEFT)])
    moved = geometry(gaze=GAZE_CENTRE + settings.gaze_delta + 0.05)

    feed(session, at_rest())
    # Alternate moved and resting frames so the run never accumulates.
    feed(session, [moved, geometry()] * 10)

    assert session.status is LivenessStatus.IN_PROGRESS


def test_losing_the_face_resets_gaze_progress():
    """Progress must not survive a gap the attacker could swap something into."""
    session = LivenessSession("s9", [ChallengeStep(ActionType.LOOK_LEFT)])
    moved = [geometry(gaze=GAZE_CENTRE + settings.gaze_delta + 0.05)] * (
        settings.gaze_hold_frames - 1
    )

    feed(session, at_rest() + moved)
    feed(session, [None])
    feed(session, moved)

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

    feed(session, eye_move_frames(+settings.gaze_delta + 0.02))
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
