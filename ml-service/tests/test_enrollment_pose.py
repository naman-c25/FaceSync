"""Checking an enrollment sample against the pose that was asked for.

The direction tests are the ones that matter. Getting left and right the wrong
way round would reject people for doing exactly what they were told, which is
worse than the unchecked prompts this replaces -- so every direction is
asserted explicitly rather than by symmetry with the one above it.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import enrollment_pose
from enrollment_pose import Pose, check, for_prompt
from face_detection import (
    CHIN_BOTTOM,
    FOREHEAD_TOP,
    IMG_LEFT_FACE_EDGE,
    IMG_RIGHT_FACE_EDGE,
    NOSE_TIP,
    head_pitch_ratio,
    head_yaw_ratio,
)

TURN = 0.06
TILT = 0.05
STRAIGHT = 0.70

# Comfortably past the thresholds rather than exactly on them. `0.5 - TILT` is
# not 0.45 in binary floating point, and a test sitting on the boundary asserts
# the rounding rather than the rule.
PAST_TURN = TURN * 2
PAST_TILT = TILT * 2


def at(yaw=0.5, pitch=0.5, frontality=1.0):
    """Run the check for a pose against a synthetic reading."""

    def run(pose):
        return check(
            pose,
            yaw=yaw,
            pitch=pitch,
            frontality=frontality,
            turn=TURN,
            tilt=TILT,
            straight=STRAIGHT,
        )

    return run


class TestPromptMapping:
    def test_every_shipped_prompt_maps_to_a_pose(self):
        # A prompt added to ENROLLMENT_GUIDANCE without an entry here would be
        # silently unchecked -- exactly the bug this module exists to fix.
        from app import ENROLLMENT_GUIDANCE

        for prompt in ENROLLMENT_GUIDANCE:
            assert for_prompt(prompt) is not None, f"unmapped prompt: {prompt!r}"

    def test_an_unknown_prompt_is_not_a_pose(self):
        assert for_prompt("Wink twice") is None
        assert for_prompt(None) is None
        assert for_prompt("") is None


class TestTurning:
    """Left and right, in the convention `head_yaw_ratio` actually produces.

    Yaw rises as the head turns toward the image's right. Frames are not
    mirrored, so the subject's left *is* the image's right -- "turn left" wants
    the yaw to go up.
    """

    def test_turning_left_passes_when_yaw_rises(self):
        assert at(yaw=0.5 + PAST_TURN)(Pose.LEFT).ok

    def test_turning_right_passes_when_yaw_falls(self):
        assert at(yaw=0.5 - PAST_TURN)(Pose.RIGHT).ok

    def test_not_moving_is_not_turning_left(self):
        result = at(yaw=0.5)(Pose.LEFT)
        assert not result.ok
        assert result.reason == "not_turned_enough"

    def test_not_moving_is_not_turning_right(self):
        result = at(yaw=0.5)(Pose.RIGHT)
        assert not result.ok
        assert result.reason == "not_turned_enough"

    def test_turning_the_wrong_way_says_so(self):
        # The case the whole feature is for. "Turn further" would be actively
        # misleading here -- they would turn further wrong.
        asked_left = at(yaw=0.5 - PAST_TURN)(Pose.LEFT)
        assert not asked_left.ok
        assert asked_left.reason == "turned_right"

        asked_right = at(yaw=0.5 + PAST_TURN)(Pose.RIGHT)
        assert not asked_right.ok
        assert asked_right.reason == "turned_left"

    def test_a_small_movement_is_not_enough(self):
        result = at(yaw=0.5 + TURN / 2)(Pose.LEFT)
        assert not result.ok
        assert result.reason == "not_turned_enough"

    def test_reports_what_it_measured(self):
        assert at(yaw=0.62)(Pose.LEFT).measured == 0.62


class TestTilting:
    """Chin up and down, where the ratio runs backwards.

    `head_pitch_ratio` falls as the chin lifts, because raising it brings the
    forehead toward the camera and the nose with it.
    """

    def test_chin_up_passes_when_pitch_falls(self):
        assert at(pitch=0.5 - PAST_TILT)(Pose.CHIN_UP).ok

    def test_chin_down_passes_when_pitch_rises(self):
        assert at(pitch=0.5 + PAST_TILT)(Pose.CHIN_DOWN).ok

    def test_not_moving_is_not_tilting(self):
        assert at(pitch=0.5)(Pose.CHIN_UP).reason == "not_tilted_enough"
        assert at(pitch=0.5)(Pose.CHIN_DOWN).reason == "not_tilted_enough"

    def test_tilting_the_wrong_way_says_so(self):
        assert at(pitch=0.5 + PAST_TILT)(Pose.CHIN_UP).reason == "chin_down"
        assert at(pitch=0.5 - PAST_TILT)(Pose.CHIN_DOWN).reason == "chin_up"


class TestStraight:
    def test_head_on_passes(self):
        assert at(frontality=1.0)(Pose.STRAIGHT).ok

    def test_a_turned_head_does_not(self):
        result = at(frontality=0.4)(Pose.STRAIGHT)
        assert not result.ok
        assert result.reason == "pose_not_straight"

    def test_the_boundary_is_inclusive(self):
        assert at(frontality=STRAIGHT)(Pose.STRAIGHT).ok

    def test_straight_ignores_yaw_and_pitch_directly(self):
        # Frontality already derives from yaw, so checking both would be the
        # same test twice -- and a face can be square while glancing about.
        assert at(frontality=0.95, yaw=0.5, pitch=0.9)(Pose.STRAIGHT).ok


class TestAgainstRealGeometry:
    """The ratios themselves, from landmark positions rather than fixtures.

    These are what guarantee the thresholds above point at reality: if
    `head_yaw_ratio` ever changed direction, the pose checks would keep passing
    their own fixtures while rejecting real people.
    """

    @staticmethod
    def mesh(nose_x=0.0, nose_y=0.0):
        """A minimal face: two edges, forehead, chin, and a movable nose."""
        points = np.zeros((478, 2), dtype=np.float32)
        points[IMG_LEFT_FACE_EDGE] = (-1.0, 0.0)
        points[IMG_RIGHT_FACE_EDGE] = (1.0, 0.0)
        points[FOREHEAD_TOP] = (0.0, -1.0)
        points[CHIN_BOTTOM] = (0.0, 1.0)
        points[NOSE_TIP] = (nose_x, nose_y)
        return points

    def test_a_centred_nose_reads_as_square_and_level(self):
        points = self.mesh()
        assert head_yaw_ratio(points) == pytest.approx(0.5)
        assert head_pitch_ratio(points) == pytest.approx(0.5)

    def test_the_nose_moving_toward_the_image_right_raises_yaw(self):
        # Which is what the subject turning to *their* left looks like on an
        # unmirrored frame, and is the direction "turn left" is checked in.
        assert head_yaw_ratio(self.mesh(nose_x=0.4)) > 0.5
        assert head_yaw_ratio(self.mesh(nose_x=-0.4)) < 0.5

    def test_a_raised_chin_lowers_pitch(self):
        # Raising the chin rotates the forehead toward the camera, so the nose
        # ends up nearer the top of the head -- a smaller ratio.
        raised = head_pitch_ratio(self.mesh(nose_y=-0.4))
        lowered = head_pitch_ratio(self.mesh(nose_y=0.4))
        assert raised < 0.5 < lowered

    def test_the_real_ratios_satisfy_the_real_checks(self):
        # End to end: a landmark position, through the ratio, through the rule.
        turned_left = self.mesh(nose_x=0.4)
        assert check(
            Pose.LEFT,
            yaw=head_yaw_ratio(turned_left),
            pitch=0.5,
            frontality=0.5,
            turn=TURN,
            tilt=TILT,
            straight=STRAIGHT,
        ).ok

        chin_up = self.mesh(nose_y=-0.4)
        assert check(
            Pose.CHIN_UP,
            yaw=0.5,
            pitch=head_pitch_ratio(chin_up),
            frontality=1.0,
            turn=TURN,
            tilt=TILT,
            straight=STRAIGHT,
        ).ok


class TestShippedTolerances:
    def test_a_natural_turn_clears_the_shipped_threshold(self):
        # Sanity on the configured numbers rather than the test's own. A person
        # asked to turn "slightly" moves well past six per cent of face span;
        # this fails loudly if someone tightens the setting into a game.
        from config import settings

        assert settings.enrollment_turn_offset <= 0.10
        assert settings.enrollment_tilt_offset <= 0.10
        assert 0.5 < settings.enrollment_straight_frontality < 0.9


class TestBaselines:
    """Movement is measured from where this person's head actually rests.

    Assuming 0.5 was a bug, and a real face is what found it: yaw does land
    near 0.5 on a frontal face, but pitch reads about 0.60 while perfectly
    level, because the nose is not midway between the top of the forehead and
    the point of the chin. Against a fixed midpoint that face passes "chin
    down" without moving and needs three times the intended movement for "chin
    up". Proportions vary between people, so measuring the person is the fix.
    """

    REST_PITCH = 0.60  # what a real level face measured

    def with_baseline(self, pose, *, yaw=0.5, pitch=REST_PITCH):
        return check(
            pose,
            yaw=yaw,
            pitch=pitch,
            frontality=1.0,
            turn=TURN,
            tilt=TILT,
            straight=STRAIGHT,
            baseline_yaw=0.5,
            baseline_pitch=self.REST_PITCH,
        )

    def test_resting_still_is_not_a_tilt_in_either_direction(self):
        # The actual bug. Without a baseline, a pitch of 0.60 is 0.10 above the
        # assumed midpoint and sails past a 0.05 threshold as "chin down".
        assert self.with_baseline(Pose.CHIN_DOWN).reason == "not_tilted_enough"
        assert self.with_baseline(Pose.CHIN_UP).reason == "not_tilted_enough"

    def test_without_a_baseline_that_same_face_passes_without_moving(self):
        # Kept as the demonstration of why the baseline is needed. If this ever
        # starts failing, the fallback has changed and the comment above is
        # stale.
        assert at(pitch=self.REST_PITCH)(Pose.CHIN_DOWN).ok

    def test_movement_from_rest_is_what_counts(self):
        assert self.with_baseline(Pose.CHIN_DOWN, pitch=self.REST_PITCH + PAST_TILT).ok
        assert self.with_baseline(Pose.CHIN_UP, pitch=self.REST_PITCH - PAST_TILT).ok

    def test_the_wrong_way_is_still_caught_from_a_baseline(self):
        moved_down = self.with_baseline(Pose.CHIN_UP, pitch=self.REST_PITCH + PAST_TILT)
        assert moved_down.reason == "chin_down"

    def test_an_off_centre_yaw_baseline_is_respected(self):
        # Somebody sitting slightly turned, or a camera mounted off to one side.
        turned_at_rest = 0.56
        result = check(
            Pose.LEFT,
            yaw=turned_at_rest,
            pitch=0.5,
            frontality=0.9,
            turn=TURN,
            tilt=TILT,
            straight=STRAIGHT,
            baseline_yaw=turned_at_rest,
            baseline_pitch=0.5,
        )
        assert result.reason == "not_turned_enough", "rest read as a completed turn"
