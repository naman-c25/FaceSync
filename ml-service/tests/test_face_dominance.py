"""Choosing which face is paying when more than one is in shot.

A kiosk in a busy shop nearly always has somebody in the background, and
refusing every frame that contains two faces makes the terminal unusable. So
one face may be accepted alongside others, but only when it is unmistakably
the subject.

The rule has to hold in two places at once, and that is the part worth testing.
Liveness reads the face mesh while the embedding comes from the detector, so if
those two ever picked different people, a bystander's blinks would satisfy the
challenge for whoever the detector charged. Both choose the largest face, and
both apply the same dominance ratio.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import face_detection  # noqa: E402
import preprocessing  # noqa: E402
from app import _single_usable_face  # noqa: E402
from config import settings  # noqa: E402
from recognition import DetectedFace  # noqa: E402

LFW = Path(__file__).resolve().parents[2] / "benchmark-data" / "lfw_funneled"
needs_lfw = pytest.mark.skipif(
    not LFW.is_dir(), reason="benchmark-data/lfw_funneled not present"
)


def face(size: int, *, at: tuple[int, int] = (0, 0), score: float = 0.9) -> DetectedFace:
    """A detector result of a given square size. Only geometry is read here."""
    x, y = at
    return DetectedFace(
        embedding=np.zeros(512, dtype=np.float32),
        bbox=(x, y, x + size, y + size),
        det_score=score,
        keypoints=np.zeros((5, 2), dtype=np.float32),
    )


class TestTheDetectorPath:
    """`_single_usable_face`, which decides where the embedding comes from."""

    def test_a_lone_face_is_taken(self, monkeypatch):
        chosen = face(400)
        monkeypatch.setattr("recognition.detect_faces", lambda _f: [chosen])

        found, reason = _single_usable_face(np.zeros((720, 1280, 3), dtype=np.uint8))

        assert reason is None
        assert found is chosen

    def test_a_distant_bystander_does_not_block_the_payment(self, monkeypatch):
        # The case the rule exists for. Someone at the till fills the frame;
        # someone browsing two metres behind them does not. Refusing here would
        # mean the terminal stops working whenever the shop has customers.
        payer = face(400)
        bystander = face(120, at=(900, 40))
        monkeypatch.setattr(
            "recognition.detect_faces", lambda _f: [bystander, payer]
        )

        found, reason = _single_usable_face(np.zeros((720, 1280, 3), dtype=np.uint8))

        assert reason is None
        assert found is payer, "the wrong face was taken"

    def test_two_comparable_faces_are_refused(self, monkeypatch):
        # Two people leaning in together. The system genuinely cannot tell which
        # of them is paying, and taking the marginally larger one would be a
        # coin flip charged to somebody's account.
        monkeypatch.setattr(
            "recognition.detect_faces",
            lambda _f: [face(400), face(360, at=(500, 0))],
        )

        found, reason = _single_usable_face(np.zeros((720, 1280, 3), dtype=np.uint8))

        assert found is None
        assert reason == "multiple_faces_detected"

    def test_the_ratio_is_where_it_says_it_is(self, monkeypatch):
        # Just inside and just outside, so the boundary is pinned rather than
        # left to whatever the constant happens to be.
        ratio = settings.face_dominance_ratio
        base = 300

        for factor, expected in ((ratio * 1.05, None), (ratio * 0.95, "multiple_faces_detected")):
            # Areas are squares of the side, so the side scales by the root.
            side = int(base * (factor**0.5))
            monkeypatch.setattr(
                "recognition.detect_faces",
                lambda _f, s=side: [face(s), face(base, at=(900, 0))],
            )
            _, reason = _single_usable_face(np.zeros((1400, 2000, 3), dtype=np.uint8))
            assert reason == expected, f"at {factor:.2f}x the area"

    def test_a_crowd_is_judged_against_the_nearest_rival_only(self, monkeypatch):
        # Three faces where the top two are close. The third being tiny must not
        # rescue a decision the top two have already made ambiguous.
        monkeypatch.setattr(
            "recognition.detect_faces",
            lambda _f: [face(400), face(370, at=(500, 0)), face(40, at=(1200, 0))],
        )

        _, reason = _single_usable_face(np.zeros((720, 1280, 3), dtype=np.uint8))

        assert reason == "multiple_faces_detected"


@needs_lfw
class TestTheMeshPath:
    """`analyse`, which decides where the liveness geometry comes from."""

    @staticmethod
    def _two_faces(big_scale: float, small_scale: float) -> np.ndarray:
        """A frame holding two real faces at chosen sizes, side by side."""
        people = sorted(p for p in LFW.iterdir() if p.is_dir())
        images = []
        for person in people:
            found = sorted(person.glob("*.jpg"))
            if found:
                images.append(found[0])
            if len(images) == 2:
                break

        canvas = np.full((900, 1600, 3), 40, dtype=np.uint8)
        for image_path, scale, x in zip(images, (big_scale, small_scale), (60, 1000)):
            face_img = preprocessing.decode_image(image_path.read_bytes())
            side = int(250 * scale)
            resized = cv2.resize(face_img, (side, side))
            canvas[80 : 80 + side, x : x + side] = resized
        return canvas

    def test_it_reports_how_many_faces_it_saw(self):
        frame = self._two_faces(2.2, 2.0)
        geometry = face_detection.analyse(frame)

        assert geometry is not None
        assert geometry.faces_seen >= 2

    def test_a_dominant_face_is_the_one_measured(self):
        # The mesh must land on the same person the detector would, or liveness
        # ends up reading one face while the payment charges another.
        frame = self._two_faces(2.4, 0.8)
        geometry = face_detection.analyse(frame)

        assert geometry is not None
        assert geometry.dominance >= settings.face_dominance_ratio

        # The big face is on the left of the canvas, so that is where the mesh
        # should be.
        assert geometry.landmarks[:, 0].mean() < frame.shape[1] / 2

    def test_comparable_faces_report_no_dominance(self):
        frame = self._two_faces(2.2, 2.0)
        geometry = face_detection.analyse(frame)

        assert geometry is not None
        assert geometry.dominance < settings.face_dominance_ratio

    def test_a_lone_face_has_nothing_to_compete_with(self):
        image = next(
            sorted(p.glob("*.jpg"))[0]
            for p in sorted(x for x in LFW.iterdir() if x.is_dir())
            if sorted(p.glob("*.jpg"))
        )
        geometry = face_detection.analyse(preprocessing.decode_image(image.read_bytes()))

        assert geometry is not None
        assert geometry.faces_seen == 1
        assert geometry.dominance == float("inf")
