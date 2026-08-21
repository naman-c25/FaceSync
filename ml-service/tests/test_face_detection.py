"""Face mesh geometry tests.

The EAR and gaze helpers are pure coordinate arithmetic, so they are tested
against hand-built landmark arrays with known answers rather than real faces.
"""

import sys
import threading
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import face_detection
from face_detection import _axis_ratio, eye_aspect_ratio


def test_eye_aspect_ratio_matches_a_hand_computed_value():
    points = np.zeros((478, 2), dtype=np.float32)

    # A 10-wide eye with two 2-tall vertical measurements:
    #   (2 + 2) / (2 * 10) = 0.2
    points[33], points[133] = (0.0, 0.0), (10.0, 0.0)
    points[160], points[144] = (2.0, 1.0), (2.0, -1.0)
    points[158], points[153] = (4.0, 1.0), (4.0, -1.0)

    ratio = eye_aspect_ratio(points, (33, 133), ((160, 144), (158, 153)))
    assert ratio == pytest.approx(0.2)


def test_eye_aspect_ratio_is_scale_invariant():
    """Why EAR divides by the eye's own width.

    A face closer to the camera has a bigger eye in pixels but the same
    openness, so the threshold has to hold across distances.
    """
    small = np.zeros((478, 2), dtype=np.float32)
    small[33], small[133] = (0.0, 0.0), (10.0, 0.0)
    small[160], small[144] = (2.0, 1.5), (2.0, -1.5)
    small[158], small[153] = (4.0, 1.5), (4.0, -1.5)

    large = small * 7.0

    indices = ((33, 133), ((160, 144), (158, 153)))
    assert eye_aspect_ratio(small, *indices) == pytest.approx(
        eye_aspect_ratio(large, *indices)
    )


def test_eye_aspect_ratio_survives_degenerate_landmarks():
    """A collapsed eye width must not divide by zero."""
    points = np.zeros((478, 2), dtype=np.float32)
    assert eye_aspect_ratio(points, (33, 133), ((160, 144), (158, 153))) == 0.0


def test_axis_ratio_places_the_iris_along_the_eye():
    points = np.zeros((478, 2), dtype=np.float32)
    points[33], points[133] = (0.0, 0.0), (10.0, 0.0)

    for x, expected in [(0.0, 0.0), (5.0, 0.5), (10.0, 1.0)]:
        points[468] = (x, 0.0)
        assert _axis_ratio(points, 468, 33, 133) == pytest.approx(expected)


def test_axis_ratio_is_clipped_to_the_eye():
    points = np.zeros((478, 2), dtype=np.float32)
    points[33], points[133] = (0.0, 0.0), (10.0, 0.0)

    points[468] = (-40.0, 0.0)
    assert _axis_ratio(points, 468, 33, 133) == 0.0
    points[468] = (40.0, 0.0)
    assert _axis_ratio(points, 468, 33, 133) == 1.0


def test_axis_ratio_ignores_head_tilt():
    """Projecting onto the eye axis is what stops a tilted head reading as a glance.

    Comparing raw x coordinates instead would make any rotated face look like
    it was looking sideways.
    """
    points = np.zeros((478, 2), dtype=np.float32)
    points[33], points[133] = (0.0, 0.0), (10.0, 0.0)
    points[468] = (5.0, 0.0)
    upright = _axis_ratio(points, 468, 33, 133)

    angle = np.radians(30.0)
    rotation = np.array(
        [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]],
        dtype=np.float32,
    )
    tilted = points @ rotation.T

    assert _axis_ratio(tilted, 468, 33, 133) == pytest.approx(upright, abs=1e-5)


@pytest.mark.slow
def test_analyse_does_not_deadlock_without_an_explicit_warm_up():
    """Regression test for a deadlock on the very first analyse() call.

    One lock used to cover both model construction and inference: analyse()
    took it, then _get_detector() tried to take it again, and threading.Lock
    is not reentrant — so the call hung forever. Everything that exercised the
    service called warm_up() during startup first, which set the detector and
    made _get_detector() return before touching the lock, hiding the bug. The
    webcam tool did not, and hung on its first frame with no window ever shown.
    """
    face_detection._detector = None
    blank = np.zeros((240, 320, 3), dtype=np.uint8)

    finished = threading.Event()

    def run():
        face_detection.analyse(blank)
        finished.set()

    threading.Thread(target=run, daemon=True).start()

    assert finished.wait(timeout=60), "analyse() deadlocked on its first call"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
