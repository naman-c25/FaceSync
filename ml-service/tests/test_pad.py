"""Anti-spoofing: the models, and the crop they have to be given.

The crop is what most of these are about. The models were trained on a bounding
box expanded by a fixed factor -- 2.7 for one, 4.0 for the other -- and handed
something much tighter they still answer, still confidently, and the answer is
worth nothing.

The reference clamps silently to the image edge when the expansion will not
fit, and that turns out to be the normal path: every one of the reference
project's own sample images clamps, landing between 1.90 and 2.62, and the
models classify them correctly there. So clamping is fine and refusing to run
without the full expansion would refuse everything.

Clamping far down is not fine. The single reference sample the models get wrong
-- a printout held close to the lens, read as real -- is also the only one whose
crop collapses to 1.21. Hence a floor rather than an exact fit, and a third
outcome, "could not judge", which is neither pass nor fail and must never be
read as either.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pad  # noqa: E402
import preprocessing  # noqa: E402
from config import settings  # noqa: E402

SAMPLES = (
    Path(__file__).resolve().parents[2] / "benchmark-data" / "pad-models" / "sample"
)
needs_models = pytest.mark.skipif(
    not pad.models_present(), reason="run setup_pad_models.py"
)
needs_samples = pytest.mark.skipif(
    not SAMPLES.is_dir(), reason="reference sample images not downloaded"
)


class TestTheCropRule:
    """Geometry only -- no model needed, and this is the part that goes wrong."""

    def test_a_scale_that_fits_is_used_in_full(self):
        # A face a fifth of the frame leaves room for the whole 4x expansion.
        _box, achieved = pad._expand(1000, 1000, (400, 400, 600, 600), 4.0)
        assert achieved == pytest.approx(4.0)

    def test_a_scale_that_does_not_fit_is_clamped_and_says_so(self):
        # A face half the frame cannot expand fourfold, so it gets what the
        # frame allows. Clamping is the reference behaviour and the models cope
        # with it; what matters is that how far it fell is reported rather than
        # hidden, because that is what the floor is applied to.
        _box, achieved = pad._expand(1000, 1000, (250, 250, 750, 750), 4.0)
        assert achieved == pytest.approx(2.0, abs=0.01)

    def test_the_clamp_tracks_the_face_size(self):
        for box_size, expected in ((250, 4.0), (500, 2.0), (800, 1.25)):
            _box, achieved = pad._expand(1000, 1000, (0, 0, box_size, box_size), 4.0)
            assert achieved == pytest.approx(expected, abs=0.02), box_size

    def test_a_face_near_an_edge_keeps_its_scale(self):
        # Shifted back inside rather than clipped, so the face occupies the same
        # fraction of the crop as it would mid-frame. A held-up photograph is
        # very often near an edge.
        (left, top, right, bottom), _achieved = pad._expand(
            1000, 1000, (0, 0, 200, 200), 4.0
        )
        assert (right - left, bottom - top) == pytest.approx((800, 800), abs=2)
        assert left >= 0 and top >= 0

    def test_a_degenerate_box_is_refused(self):
        assert pad._expand(1000, 1000, (500, 500, 500, 500), 2.7) is None


@needs_models
class TestVerdicts:
    @staticmethod
    def _framed(face: np.ndarray, fraction: float) -> tuple[np.ndarray, tuple]:
        """Paste a face into a canvas so it occupies `fraction` of the height."""
        side = 1000
        canvas = np.full((side, side, 3), 60, dtype=np.uint8)
        size = int(side * fraction)
        resized = cv2.resize(face, (size, size))
        top = left = (side - size) // 2
        canvas[top : top + size, left : left + size] = resized
        return canvas, (left, top, left + size, top + size)

    def test_a_face_filling_the_frame_gets_no_verdict(self):
        # The failure this module is shaped around. Nothing is asserted about
        # real or fake -- the point is that it declines to say, because the one
        # reference sample the models get wrong is the one whose crop collapses
        # like this.
        frame = np.full((400, 400, 3), 128, dtype=np.uint8)
        verdict = pad.assess(frame, (20, 20, 380, 380))

        assert verdict.available is False
        assert verdict.is_attack is False, "no verdict must not read as an attack"
        assert verdict.reason == "face_too_large_for_crop"
        assert verdict.crop_scale < settings.pad_min_crop_scale

    def test_a_clamped_but_workable_crop_still_gets_a_verdict(self):
        # The reference's own samples all clamp, to between 1.90 and 2.62, and
        # the models classify them correctly there. Refusing everything that
        # clamps would refuse everything.
        frame = np.full((1000, 1000, 3), 128, dtype=np.uint8)
        verdict = pad.assess(frame, (250, 250, 750, 750))

        assert verdict.available is True
        assert 1.5 <= verdict.crop_scale < 4.0

    def test_a_well_framed_face_gets_a_verdict(self):
        frame = np.full((1000, 1000, 3), 128, dtype=np.uint8)
        verdict = pad.assess(frame, (400, 400, 600, 600))

        assert verdict.available is True
        assert verdict.models_used == 2, "both models should have had their crop"
        assert 0.0 <= verdict.real_score <= 1.0

    def test_disabled_produces_no_verdict(self, monkeypatch):
        monkeypatch.setattr(settings, "pad_enabled", False)
        verdict = pad.assess(np.zeros((1000, 1000, 3), dtype=np.uint8), (400, 400, 600, 600))

        assert verdict.available is False
        assert verdict.is_attack is False
        assert verdict.reason == "pad_disabled"


@needs_models
@needs_samples
class TestAgainstRealAttacks:
    """The reference project's own labelled images: T = live, F = attack.

    These are the only genuine presentation attacks available without a camera
    -- an actual print and actual screens, photographed. A simulation could not
    stand in for them, because the entire signal is sensor-level.
    """

    @staticmethod
    def _load(name: str):
        import recognition

        image = preprocessing.decode_image((SAMPLES / name).read_bytes())
        if image is None:
            return None, None
        faces = recognition.detect_faces(image)
        if not faces:
            return image, None
        face = max(faces, key=lambda f: f.bbox_area)
        return image, face.bbox

    @pytest.mark.parametrize("name", ["image_T1.jpg", "image_T2.jpg"])
    def test_a_live_capture_scores_high(self, name):
        image, bbox = self._load(name)
        if bbox is None:
            pytest.skip(f"no face found in {name}")

        verdict = pad.assess(image, bbox)
        if not verdict.available:
            pytest.skip(f"{name} could not be framed for the models")

        assert verdict.real_score > 0.9, f"{name} scored {verdict.real_score}"
        assert not verdict.is_attack

    @pytest.mark.parametrize("name", ["image_F1.jpg", "image_F2.jpg", "image_F3.jpg", "image_F5.jpg"])
    def test_a_real_attack_is_caught(self, name):
        image, bbox = self._load(name)
        if bbox is None:
            pytest.skip(f"no face found in {name}")

        verdict = pad.assess(image, bbox)
        if not verdict.available:
            pytest.skip(f"{name} could not be framed for the models")

        assert verdict.is_attack, f"{name} scored {verdict.real_score} real"

    def test_the_one_the_models_get_wrong_is_declined_instead(self):
        """image_F6 is a printout held close to the lens, and the models read it
        as a real face -- the single miss in the reference set.

        It is also the only sample whose crop collapses to 1.21, far below what
        either model was trained on. The floor catches exactly that case, so the
        answer is "could not judge" rather than a wrong one. Declining is not a
        fix for the miss, but it is the honest handling of it: the models were
        not given what they need, so their answer is not used.
        """
        image, bbox = self._load("image_F6.png")
        if bbox is None:
            pytest.skip("no face found in image_F6.png")

        verdict = pad.assess(image, bbox)

        assert verdict.available is False
        assert verdict.is_attack is False
        assert verdict.crop_scale < settings.pad_min_crop_scale
