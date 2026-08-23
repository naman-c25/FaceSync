"""Liveness state machine tests.

The state machine takes `FaceGeometry` values, not images, so every scenario
here — including the spoof attempts — is driven by synthetic landmark data.
No camera, no model, no fixtures to record.
"""

import random
import sys
from math import ceil
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


# Blink and gaze thresholds are measured in milliseconds, so the tests advance
# a clock rather than relying on wall time. 40ms per frame is 25fps — a normal
# local capture rate.
FRAME_MS = 40.0


class Clock:
    """A fake monotonic clock the tests step forward frame by frame."""

    def __init__(self, step_ms: float = FRAME_MS) -> None:
        self.now = 1000.0
        self.step_ms = step_ms

    def tick(self) -> float:
        self.now += self.step_ms / 1000.0
        return self.now


def feed(
    session: LivenessSession,
    frames: list[FaceGeometry | None],
    clock: Clock | None = None,
) -> Clock:
    """Submit frames, advancing the clock one step per frame.

    The clock is kept on the session so that several `feed` calls in one test
    read as one continuous capture. A fresh clock per call would rewind time
    between them, which the state machine sees as a closure that ended before
    it began.
    """
    if clock is None:
        clock = getattr(session, "_test_clock", None) or Clock()
        session._test_clock = clock

    for frame in frames:
        session.submit_frame(frame, now=clock.tick())
    return clock


def eyes_open_baseline(ear: float = EYES_OPEN) -> list[FaceGeometry]:
    """Frames a blink step uses to learn this person's open-eye EAR."""
    return [geometry(ear=ear)] * settings.ear_baseline_frames


# Frames needed to span each time threshold at FRAME_MS. Derived rather than
# hardcoded so the tests follow the config instead of drifting from it.
#
# The closure is measured from the first closed frame to the first open one, so
# N closed frames measures N * FRAME_MS. The gaze timer starts on the first
# satisfied frame and reads zero there, hence the extra frame.
CLOSED_FRAMES = max(2, ceil(settings.blink_min_ms / FRAME_MS))
GAZE_FRAMES = ceil(settings.gaze_hold_ms / FRAME_MS) + 1


def blink_frames(count: int, open_ear: float = EYES_OPEN) -> list[FaceGeometry]:
    """Baseline, then eyes shut long enough to register, then open again."""
    closed = [geometry(ear=open_ear * 0.2)] * CLOSED_FRAMES
    opened = [geometry(ear=open_ear)] * 2
    return eyes_open_baseline(open_ear) + (closed + opened) * count


def at_rest(count: int | None = None) -> list[FaceGeometry]:
    """Frames the step uses to learn where this person sits at rest."""
    count = settings.baseline_frames if count is None else count
    return [geometry()] * count


def eye_move_frames(shift: float, count: int | None = None) -> list[FaceGeometry]:
    """Rest, then the eyes swivel by `shift` from it."""
    count = GAZE_FRAMES if count is None else count
    return at_rest() + [geometry(gaze=GAZE_CENTRE + shift)] * count


def head_turn_frames(shift: float, count: int | None = None) -> list[FaceGeometry]:
    """Rest, then the head turns by `shift` with the eyes following it round.

    Someone who turns their head and lets their gaze go with it keeps the iris
    where it was between the eye corners, so the gaze ratio does not move.

    This is only one of the two ways a head turn looks. For the other -- eyes
    staying on the screen while the head goes -- see
    `head_turn_eyes_on_screen_frames`, which is the one that found a bug.
    """
    count = GAZE_FRAMES if count is None else count
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
    feed(session, [geometry(ear=EYES_SHUT)] * CLOSED_FRAMES)

    assert session.status is LivenessStatus.IN_PROGRESS
    assert session.signals.blinks_detected == 0


def test_single_frame_dip_is_not_a_blink():
    """Guards against landmark jitter being counted as a blink."""
    session = LivenessSession("s3", [ChallengeStep(ActionType.BLINK, count=1)])
    feed(session, [geometry(ear=EYES_SHUT), geometry(ear=EYES_OPEN)] * 5)

    assert session.signals.blinks_detected == 0
    assert session.status is LivenessStatus.IN_PROGRESS


def test_capture_rate_is_what_decides_whether_a_blink_is_seen():
    """Why frames are batched rather than sent one per request.

    A blink is a ~250ms event. Sampling at the rate a browser can *ship*
    frames over a tunnel — 3 or 4 a second — means the closure often falls
    entirely between two samples and is never observed at all. Sampling at the
    rate a browser can *capture* them catches it every time.

    This is the difference the batching exists to buy, and it explains why gaze
    challenges passed on connections where blink challenges failed: a gaze is a
    held position and shows up in any frame, while a blink has to be caught in
    the act.
    """
    # A normal blink. Deliberate ones run longer, but this is the case that has
    # to work, and it is short enough that the sampling rate decides the outcome.
    BLINK_MS = 150.0
    TRIALS = 200

    def detection_rate(fps: float) -> float:
        """Share of blinks caught at `fps`, over random blink timings.

        The offset has to be random. A blink starting exactly on a frame
        boundary is the best case for any rate, and measuring only that would
        make a slow rate look fine.
        """
        frame_ms = 1000.0 / fps
        rng = random.Random(20260822)
        caught = 0

        for _ in range(TRIALS):
            clock = Clock(step_ms=frame_ms)
            session = LivenessSession("rate", [ChallengeStep(ActionType.BLINK, count=1)])
            feed(session, eyes_open_baseline(), clock)

            blink_start = clock.now * 1000.0 + rng.uniform(0, frame_ms)
            for _ in range(int(1500 / frame_ms) + 2):
                now_ms = clock.now * 1000.0
                closed = blink_start <= now_ms < blink_start + BLINK_MS
                session.submit_frame(
                    geometry(ear=EYES_SHUT if closed else EYES_OPEN), now=clock.tick()
                )

            caught += session.signals.blinks_detected >= 1

        return caught / TRIALS

    shipped = detection_rate(4)  # one frame per request, over a tunnel
    captured = detection_rate(15)  # what the camera itself can do

    assert captured > 0.95, f"capture rate should be near-certain, got {captured:.0%}"
    assert shipped < 0.8, (
        f"4fps caught {shipped:.0%} — if that were reliable, batching would be "
        "solving a problem that does not exist"
    )


@pytest.mark.parametrize("fps", [30, 25, 15, 10, 6, 4])
def test_a_blink_is_detected_at_any_frame_rate(fps):
    """The reason the thresholds are in milliseconds rather than frames.

    A browser streaming frames to a server runs at whatever the round trip
    allows — often 5-8fps against 30 locally. A frame-counted threshold tuned
    on a laptop misses every blink over a network, because a 200ms closure
    spans fewer than two frames there.

    A deliberate blink on cue lasts roughly 200-300ms; 200 is used here as the
    hard case.
    """
    frame_ms = 1000.0 / fps
    clock = Clock(step_ms=frame_ms)
    session = LivenessSession("fps", [ChallengeStep(ActionType.BLINK, count=1)])

    feed(session, eyes_open_baseline(), clock)

    closed_frames = max(1, round(200.0 / frame_ms))
    feed(session, [geometry(ear=EYES_SHUT)] * closed_frames, clock)
    feed(session, [geometry(ear=EYES_OPEN)] * 3, clock)

    assert session.signals.blinks_detected == 1, (
        f"a 200ms blink went undetected at {fps}fps"
    )


@pytest.mark.parametrize("fps", [30, 10, 4])
def test_noise_is_not_a_blink_at_any_frame_rate(fps):
    """The other half — the window must not widen into accepting jitter.

    One stray frame is a real closure at 4fps and landmark noise at 30, and
    measuring time rather than frames is what tells them apart.
    """
    frame_ms = 1000.0 / fps
    clock = Clock(step_ms=frame_ms)
    session = LivenessSession("noise", [ChallengeStep(ActionType.BLINK, count=1)])

    feed(session, eyes_open_baseline(), clock)
    # Alternating single frames: at 30fps each dip lasts 33ms, well under the
    # blink window; at 4fps a single frame genuinely is 250ms of closure.
    feed(session, [geometry(ear=EYES_SHUT), geometry(ear=EYES_OPEN)] * 8, clock)

    expected_a_blink = frame_ms >= settings.blink_min_ms
    assert (session.signals.blinks_detected > 0) is expected_a_blink


def test_eyes_held_shut_are_not_a_blink_at_any_frame_rate():
    """A photo of closed eyes must not pass however slowly frames arrive."""
    for fps in (30, 10, 4):
        clock = Clock(step_ms=1000.0 / fps)
        session = LivenessSession("held", [ChallengeStep(ActionType.BLINK, count=1)])

        feed(session, eyes_open_baseline(), clock)
        held_frames = ceil((settings.blink_max_ms + 400) / clock.step_ms)
        feed(session, [geometry(ear=EYES_SHUT)] * held_frames, clock)
        feed(session, [geometry(ear=EYES_OPEN)] * 3, clock)

        assert session.signals.blinks_detected == 0, f"held eyes counted at {fps}fps"


# Open-eye and blink-floor EAR measured from five people with the webcam tool.
# The spread is the reason the threshold is relative: one fixed number cannot
# sit safely between 0.086 and 0.316.
MEASURED_SUBJECTS = [
    (0.418, 0.086),
    (0.316, 0.051),
    (0.408, 0.067),
    (0.342, 0.074),
    (0.326, 0.053),
]


@pytest.mark.parametrize("open_eye,blink_floor", MEASURED_SUBJECTS)
def test_real_measured_blinks_are_detected(open_eye, blink_floor):
    """Every subject measured must be able to blink their way through."""
    session = LivenessSession("real", [ChallengeStep(ActionType.BLINK, count=2)])

    feed(session, eyes_open_baseline(open_eye))
    for _ in range(2):
        feed(session, [geometry(ear=blink_floor)] * CLOSED_FRAMES)
        feed(session, [geometry(ear=open_eye)] * 2)

    assert session.status is LivenessStatus.PASSED, (
        f"a real blink to {blink_floor} was missed for an open eye of {open_eye}"
    )


@pytest.mark.parametrize("open_eye,blink_floor", MEASURED_SUBJECTS)
def test_an_open_eye_is_never_read_as_closed(open_eye, blink_floor):
    """The other half: resting eyes must not drift under the threshold."""
    session = LivenessSession("open", [ChallengeStep(ActionType.BLINK, count=1)])

    # Resting EAR wanders a little frame to frame; none of it is a blink.
    feed(session, eyes_open_baseline(open_eye))
    feed(session, [geometry(ear=open_eye * jitter) for jitter in (1.0, 0.92, 0.97, 0.88)] * 6)

    assert session.signals.blinks_detected == 0


def test_the_threshold_adapts_to_the_person():
    """A narrow-eyed subject's blink would sit above a wide-eyed one's floor.

    Subject 2 blinks to 0.051 with an open eye of 0.316. Subject 1 blinks to
    0.086 with an open eye of 0.418. A single threshold set for either one
    misjudges the other, which is what scaling to the individual avoids.
    """
    thresholds = []
    for open_eye, _ in MEASURED_SUBJECTS:
        session = LivenessSession("t", [ChallengeStep(ActionType.BLINK, count=1)])
        feed(session, eyes_open_baseline(open_eye))
        thresholds.append(session._blink_threshold())

    assert max(thresholds) - min(thresholds) > 0.04, "threshold did not adapt"
    for threshold, (open_eye, blink_floor) in zip(thresholds, MEASURED_SUBJECTS):
        assert blink_floor < threshold < open_eye


def test_a_blink_during_baseline_does_not_raise_the_bar():
    """The baseline takes the maximum, not the mean.

    A mean would be dragged down by a blink landing in the baseline window,
    lowering the threshold and making every later blink harder to register.
    """
    session = LivenessSession("bl", [ChallengeStep(ActionType.BLINK, count=1)])

    window = [geometry(ear=EYES_OPEN)] * settings.ear_baseline_frames
    window[2] = geometry(ear=EYES_SHUT)
    window[3] = geometry(ear=EYES_SHUT)
    feed(session, window)

    assert session.signals.ear_open_baseline == pytest.approx(EYES_OPEN)


def test_the_open_eye_baseline_survives_into_later_steps():
    """Eye shape does not change between steps; re-measuring only costs frames."""
    session = LivenessSession(
        "carry",
        [ChallengeStep(ActionType.BLINK, count=1), ChallengeStep(ActionType.BLINK, count=1)],
    )
    feed(session, blink_frames(1))
    assert session.step_index == 1

    measured = session.signals.ear_open_baseline

    # No fresh baseline window — the second step blinks immediately.
    feed(session, [geometry(ear=EYES_SHUT)] * CLOSED_FRAMES)
    feed(session, [geometry(ear=EYES_OPEN)] * 2)

    assert session.status is LivenessStatus.PASSED
    assert session.signals.ear_open_baseline == measured


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

    feed(session, [geometry(ear=EYES_OPEN, yaw=slight)] * settings.ear_baseline_frames)
    closed = [geometry(ear=EYES_SHUT, yaw=slight)] * CLOSED_FRAMES
    feed(session, closed + [geometry(ear=EYES_OPEN, yaw=slight)] * 2)

    assert session.signals.blinks_detected == 1


def test_no_blink_is_scored_before_the_open_eye_is_measured():
    """The baseline window costs frames, and that has to be deliberate.

    At kiosk frame rates it is under half a second — less time than it takes to
    read the prompt — so a user who blinks on cue is not caught out by it.
    """
    session = LivenessSession("early", [ChallengeStep(ActionType.BLINK, count=1)])

    feed(session, [geometry(ear=EYES_SHUT)] * 2 + [geometry(ear=EYES_OPEN)] * 2)

    assert session.signals.blinks_detected == 0
    assert session.signals.ear_open_baseline is None


def test_a_closure_interrupted_by_a_head_turn_is_not_a_blink():
    """The end of the closure has to be seen for it to have been a blink."""
    profile = 0.5 - (settings.min_frontality_for_blink / 2.0) - 0.05
    session = LivenessSession("interrupted", [ChallengeStep(ActionType.BLINK, count=1)])

    feed(session, [geometry(ear=EYES_SHUT)] * CLOSED_FRAMES)
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
    held = ceil(settings.blink_max_ms / FRAME_MS) + 3
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

    Requiring eye movement alone would reject someone who did exactly what the
    prompt asked. Here the eyes travel with the head, so the gaze ratio stays
    at rest and the yaw carries the step on its own.
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
        GAZE_FRAMES - 1
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


def test_the_timeout_governs_at_a_realistic_capture_rate():
    """The frame budget must not end a challenge someone is still performing.

    It used to. At 150 frames and a local 30fps the budget expired after five
    seconds — long before anyone could blink twice and then turn their head —
    so the budget, not the timeout, was deciding when to give up.
    """
    clock = Clock(step_ms=1000.0 / 15)  # a normal browser capture rate
    session = LivenessSession("timeout", [ChallengeStep(ActionType.LOOK_LEFT)])

    # Run past the timeout, one frame at a time.
    frames = int(settings.liveness_timeout_seconds * 15) + 5
    feed(session, [geometry()] * frames, clock)

    assert session.status is LivenessStatus.FAILED
    assert session.failure_reason == "challenge_timeout"
    assert session.signals.frames_processed < settings.liveness_max_frames


def test_the_frame_budget_still_backstops_an_absurd_rate():
    """Compute stays bounded even if frames arrive faster than time passes."""
    clock = Clock(step_ms=1.0)  # 1000fps — nothing real, which is the point
    session = LivenessSession("budget", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, [geometry()] * (settings.liveness_max_frames + 2), clock)

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


def test_challenge_has_the_configured_length(monkeypatch):
    monkeypatch.setattr(settings, "liveness_mode", "challenge")
    assert len(generate_challenge()) == settings.challenge_steps


def test_passive_mode_asks_for_nothing(monkeypatch):
    """No steps to walk, because nothing is being demanded of the person.

    The session still exists and still watches -- see `_advance_passive` for
    exactly how little that proves.
    """
    monkeypatch.setattr(settings, "liveness_mode", "passive")
    assert generate_challenge() == []


def test_an_explicit_challenge_is_run_whatever_the_mode(monkeypatch):
    """The mode decides what gets generated, not what a session does.

    A session handed steps walks them. Anything else would mean turning on
    passive mode silently disarmed every challenge in the codebase, tests
    included, which is how a security control disappears without anyone
    noticing.
    """
    monkeypatch.setattr(settings, "liveness_mode", "passive")
    session = LivenessSession("explicit", [ChallengeStep(ActionType.LOOK_LEFT)])

    feed(session, at_rest(settings.baseline_frames + 2))
    feed(session, [geometry(yaw=HEAD_SQUARE - 0.2)] * 20)

    assert session.status is LivenessStatus.IN_PROGRESS, "the wrong way passed"
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


def head_turn_eyes_on_screen_frames(
    shift: float, count: int | None = None
) -> list[FaceGeometry]:
    """A head turn by someone who keeps watching the screen.

    This is the head turn people actually perform, and it does not look like
    `head_turn_frames` at all. The prompt is on the screen, so they read it,
    turn their head, and keep their eyes on the camera -- which means the
    eyeballs counter-rotate in their sockets to stay on target.

    In the mesh that counter-rotation moves the iris *toward the opposite eye
    corner*, so the gaze ratio swings the other way from the yaw. The two
    signals end up with opposite signs from one physical movement.
    """
    count = GAZE_FRAMES if count is None else count
    return at_rest() + [
        geometry(gaze=GAZE_CENTRE - shift, yaw=HEAD_SQUARE + shift)
    ] * count


def test_a_real_head_turn_satisfies_the_direction_it_actually_went():
    session = LivenessSession("turn-ok", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, head_turn_eyes_on_screen_frames(+settings.yaw_delta + 0.05))

    assert session.status is LivenessStatus.PASSED


def test_a_real_head_turn_does_not_satisfy_the_opposite_direction():
    """The bug this exists for, reported from a live kiosk.

    Prompted to look one way, the user turned the other way, and the challenge
    passed anyway. Every existing gaze test moves one signal while pinning the
    other at rest, so none of them could see it: a real head turn moves both,
    in opposite directions, and the step was satisfied by gaze *or* yaw with no
    check that the two agreed. Whichever one happened to point at the requested
    direction carried the step, so a single turn answered both prompts.

    That is not a cosmetic failure. Randomising the direction is what stops a
    recorded clip from being replayed, and a check that accepts either
    direction throws away most of that.
    """
    session = LivenessSession("turn-wrong", [ChallengeStep(ActionType.LOOK_RIGHT)])
    feed(session, head_turn_eyes_on_screen_frames(+settings.yaw_delta + 0.05, count=25))

    assert session.status is LivenessStatus.IN_PROGRESS


def test_the_mirror_image_of_that_turn_is_judged_the_same_way():
    """The same movement the other way round, so neither direction is special."""
    session = LivenessSession("turn-ok-2", [ChallengeStep(ActionType.LOOK_RIGHT)])
    feed(session, head_turn_eyes_on_screen_frames(-settings.yaw_delta - 0.05))
    assert session.status is LivenessStatus.PASSED

    session = LivenessSession("turn-wrong-2", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, head_turn_eyes_on_screen_frames(-settings.yaw_delta - 0.05, count=25))
    assert session.status is LivenessStatus.IN_PROGRESS


def test_small_head_drift_does_not_take_the_step_away_from_the_eyes():
    """Nobody holds their head perfectly still while moving their eyes.

    Under `yaw_still_max` the head counts as at rest and the eyes still decide,
    so someone answering with their eyes is not made to turn their head as well.
    """
    session = LivenessSession("drift", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(
        session,
        at_rest()
        + [
            geometry(
                gaze=GAZE_CENTRE + settings.gaze_delta + 0.02,
                yaw=HEAD_SQUARE + settings.yaw_still_max * 0.9,
            )
        ]
        * GAZE_FRAMES,
    )

    assert session.status is LivenessStatus.PASSED


def test_once_the_head_is_moving_the_eyes_stop_deciding():
    """The cost of the fix, written down rather than discovered later.

    Between `yaw_still_max` and `yaw_delta` the head has moved enough to make
    the iris ratio untrustworthy but not enough to count as a turn, so the step
    is not satisfied and the person has to commit to the movement.

    That is the right trade: the alternative is reading a gaze ratio that is
    describing counter-rotation, which is exactly what let one turn answer
    both prompts.
    """
    session = LivenessSession("band", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(
        session,
        at_rest()
        + [
            geometry(
                gaze=GAZE_CENTRE + settings.gaze_delta + 0.02,
                yaw=HEAD_SQUARE + (settings.yaw_still_max + settings.yaw_delta) / 2,
            )
        ]
        * 25,
    )

    assert session.status is LivenessStatus.IN_PROGRESS


def moving_frames(start: float, end: float, count: int) -> list[FaceGeometry]:
    """A head travelling from `start` to `end` yaw, one step per frame."""
    return [
        geometry(yaw=start + (end - start) * (i / max(count - 1, 1)))
        for i in range(count)
    ]


def test_a_baseline_is_not_taken_from_a_head_still_in_motion():
    """The bug a live kiosk kept hitting after the direction fix.

    A look step begins at the worst possible moment: the previous step just
    turned the head and it is on its way back to centre. Averaging the first
    few frames records a position the head was merely *passing through*, and
    the rest of that return then reads as deliberate movement away from rest.

    So whichever way the head already happened to be travelling satisfied the
    next prompt, no matter what the person did. Here the head coasts back from
    a right turn while the prompt asks for left, and nothing else happens --
    that must not be enough.
    """
    session = LivenessSession("coast", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, moving_frames(HEAD_SQUARE - 0.25, HEAD_SQUARE, 30))

    assert session.status is LivenessStatus.IN_PROGRESS
    assert session.signals.baseline_retries > 0, "the moving window was accepted"


def test_the_baseline_locks_once_the_head_settles():
    """...and the person is not punished for having moved a moment ago."""
    session = LivenessSession("settle", [ChallengeStep(ActionType.LOOK_LEFT)])

    # Coasting back to centre, then held still, then a real turn to the left.
    feed(session, moving_frames(HEAD_SQUARE - 0.25, HEAD_SQUARE, 20))
    feed(session, at_rest(settings.baseline_frames + 2))
    feed(
        session,
        [geometry(yaw=HEAD_SQUARE + settings.yaw_delta + 0.05)] * GAZE_FRAMES,
    )

    assert session.status is LivenessStatus.PASSED


def test_a_passed_look_step_records_which_signal_carried_it():
    """So the next report is read from evidence rather than reasoned about.

    Session-wide gaze and yaw ranges say how far the head moved but not from
    where, nor which way relative to what was asked -- which is exactly what
    was missing while this bug was being chased.
    """
    session = LivenessSession("evidence", [ChallengeStep(ActionType.LOOK_LEFT)])
    feed(session, head_turn_frames(+settings.yaw_delta + 0.05))

    assert session.status is LivenessStatus.PASSED
    assert len(session.signals.baselines_locked) == 1

    recorded = session.signals.step_shifts[0]
    assert recorded["asked"] == "look_left"
    assert recorded["carried_by"] == "yaw"
    assert recorded["yaw_shift"] > 0


# -- passive mode ------------------------------------------------------


def passive_session(name="p"):
    """A session with no steps, which is what passive mode produces."""
    return LivenessSession(name, [])


# Enough frames to clear both passive gates at the test clock's rate. Derived
# rather than hardcoded so these follow the config instead of drifting from it.
PASSIVE_FRAMES = max(
    settings.passive_min_frames,
    ceil(settings.passive_scan_seconds * 1000.0 / FRAME_MS) + 1,
)


def moving_face(count: int, drift: float = 0.4) -> list[FaceGeometry]:
    """Frames of a face that is not perfectly frozen, which no real one is."""
    frames = []
    for i in range(count):
        g = geometry()
        g.landmarks[:, 0] += i * drift
        frames.append(g)
    return frames


def test_passive_accepts_a_face_that_is_simply_there():
    session = passive_session()
    feed(session, moving_face(PASSIVE_FRAMES))

    assert session.status is LivenessStatus.PASSED


def test_passive_will_not_decide_from_a_glimpse():
    # One instant is not a sample of someone standing there. The window is
    # short enough not to feel like a wait and long enough to be a window.
    session = passive_session("brief")
    feed(session, moving_face(3))

    assert session.status is LivenessStatus.IN_PROGRESS


def test_passive_refuses_one_image_repeated():
    # The only presentation attack this mode actually stops: the same bytes fed
    # over and over, with no sensor noise between them. A photograph held up to
    # a camera shakes and will not look like this.
    frozen = geometry()
    session = passive_session("frozen")
    feed(session, [frozen] * (PASSIVE_FRAMES + 10))

    assert session.status is LivenessStatus.IN_PROGRESS
    assert session.signals.passive_motion_px == 0.0


def test_passive_records_what_it_saw():
    session = passive_session("recorded")
    feed(session, moving_face(PASSIVE_FRAMES))

    assert session.signals.passive_frames >= settings.passive_min_frames
    assert session.signals.passive_motion_px > 0


def test_passive_still_needs_a_face_present_throughout():
    # A gap long enough to be someone leaving still ends the session, exactly
    # as it does under a challenge.
    session = passive_session("gap")
    feed(session, moving_face(4))
    feed(session, [None] * (settings.max_consecutive_missing_face + 1))

    assert session.status is LivenessStatus.FAILED


def test_passive_reports_progress_so_the_kiosk_can_draw_something():
    # With nothing asked of the person, the filling ring is the only feedback
    # there is that anything is happening.
    session = passive_session("progress")
    feed(session, moving_face(4))
    early = session.outcome().step_progress

    feed(session, moving_face(PASSIVE_FRAMES))

    assert 0.0 < early < 1.0
    assert session.outcome().step_progress == 1.0


def crowded_frame() -> FaceGeometry:
    """A frame holding two faces of comparable size."""
    g = geometry()
    return FaceGeometry(
        landmarks=g.landmarks, ear=g.ear, ear_left=g.ear_left, ear_right=g.ear_right,
        gaze_horizontal=g.gaze_horizontal, gaze_vertical=g.gaze_vertical,
        head_yaw=g.head_yaw, frontality=g.frontality,
        faces_seen=2, dominance=1.2,
    )


def test_a_scan_mostly_unable_to_tell_who_is_who_is_refused():
    """Found by holding somebody else's photograph up to the camera.

    The holder's own face was larger, so it won the dominance rule in every
    frame it appeared in, and the till confidently named the holder. Correct by
    the rule, and useless to anyone watching -- so a scan that spent much of
    itself with two comparable faces in shot is refused outright rather than
    resolved to whoever happened to be biggest.
    """
    session = passive_session("crowded")
    frames = moving_face(PASSIVE_FRAMES)
    # Well over the allowed share of the scan.
    for i in range(0, len(frames), 2):
        frames[i] = crowded_frame()
    # The service discards crowded frames before they reach the state machine,
    # so the count is what the session sees rather than the frames themselves.
    feed(session, moving_face(PASSIVE_FRAMES))
    session.signals.frames_crowded = int(session.signals.frames_processed * 0.5)

    assert session._too_crowded() is True


def test_a_few_crowded_frames_do_not_lose_the_scan():
    # Somebody walking past should not cost a customer their payment.
    session = passive_session("passerby")
    feed(session, moving_face(PASSIVE_FRAMES))
    session.signals.frames_crowded = 1

    assert session._too_crowded() is False
    assert session.status is LivenessStatus.PASSED


def test_a_short_scan_is_not_judged_on_crowding():
    # Two crowded frames out of three is not evidence of anything.
    session = passive_session("brief-crowd")
    feed(session, moving_face(3))
    session.signals.frames_crowded = 2

    assert session._too_crowded() is False
