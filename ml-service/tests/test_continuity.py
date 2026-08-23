"""Session continuity: the face that finished the challenge is the one recognised.

The gap this closes is narrow and real. Liveness proves a live person was
*present*; it does not prove they are the person being identified. The probe is
whichever frame scored best for quality across the whole session, so passing
the challenge and then holding up a sharp, well-framed photograph can win it.

Checked with embeddings rather than by tracking geometry across frames. Two
attempts at judging identity from landmark movement were measured and abandoned
in this project -- both drowned in landmark noise at error rates no till could
live with -- and a careful swap can be geometrically smooth anyway.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import settings  # noqa: E402
from liveness import LivenessSession, LivenessStatus  # noqa: E402
from session_store import VerificationSession  # noqa: E402


def session(name="c"):
    return VerificationSession(session_id=name, liveness=LivenessSession(name, []))


def frame(value: int) -> np.ndarray:
    return np.full((80, 80, 3), value, dtype=np.uint8)


class TestWhichFramesAreKept:
    """Geometry only -- the anchor has to come from a different moment."""

    def test_the_anchor_comes_from_the_opening_frames(self):
        s = session()
        for i in range(settings.continuity_anchor_frames):
            s.offer_frame(frame(10 + i), score=float(i), sharpness=100.0)

        assert s.anchor_frame is not None
        assert s.late_frame is None, "nothing after the window yet"

    def test_a_frame_after_the_window_never_becomes_the_anchor(self):
        # Otherwise a swap late in the session would replace the very frame it
        # is supposed to be checked against, and the comparison would be of the
        # photograph with itself. Note the anchor takes the *best* of the
        # opening frames, so the window has to be filled to pin this.
        s = session()
        for _ in range(settings.continuity_anchor_frames):
            s.offer_frame(frame(10), score=1.0, sharpness=100.0)
        anchor = s.anchor_frame.copy()

        for _ in range(5):
            s.offer_frame(frame(200), score=99.0, sharpness=100.0)

        assert np.array_equal(s.anchor_frame, anchor)
        assert np.array_equal(s.late_frame, frame(200))

    def test_a_swap_inside_the_opening_window_is_not_caught(self):
        """The limit of this check, written down rather than left to be found.

        The anchor is the best of the opening frames, so a face replaced before
        that window closes becomes the anchor itself and is then compared
        against more of itself. At 15fps the window is about two thirds of a
        second.

        What stops it there is the rest of the session: under a challenge the
        prompt still has to be performed, which a photograph cannot do. Under
        passive liveness it is genuinely weaker, and the anti-spoof models are
        what carry that case.
        """
        s = session()
        s.offer_frame(frame(10), score=1.0, sharpness=100.0)
        for _ in range(settings.continuity_anchor_frames + 4):
            s.offer_frame(frame(200), score=99.0, sharpness=100.0)

        # The anchor is now the replacement, not the original.
        assert np.array_equal(s.anchor_frame, frame(200))

    def test_the_two_are_always_different_moments(self):
        s = session()
        for i in range(settings.continuity_anchor_frames + 4):
            s.offer_frame(frame(10 + i), score=float(i), sharpness=100.0)

        assert s.anchor_frame is not None and s.late_frame is not None
        assert not np.array_equal(s.anchor_frame, s.late_frame)

    def test_a_rejected_frame_still_advances_the_window(self):
        # The anchor window is a window in time, not a ranking. A frame that
        # loses on quality still happened, and counting only the winners would
        # let a long poor-quality opening keep the window open indefinitely.
        s = session()
        for _ in range(settings.continuity_anchor_frames + 1):
            s.offer_frame(frame(10), score=0.5, sharpness=100.0)

        assert s.frames_offered == settings.continuity_anchor_frames + 1


class TestTheCheck:
    """`_same_face_throughout`, with the detector stubbed to name the faces."""

    @staticmethod
    def _stub(monkeypatch, anchor_vec, late_vec):
        """Make each stored frame resolve to a chosen embedding."""
        import app

        class Face:
            def __init__(self, embedding):
                self.embedding = embedding

        seen = {}

        def fake(frame_in):
            key = int(frame_in[0, 0, 0])
            return Face(seen[key]), None

        seen[10] = anchor_vec
        seen[200] = late_vec
        monkeypatch.setattr(app, "_single_usable_face", fake)
        return app

    @staticmethod
    def _prepared():
        """One face for the whole opening window, then a different one after."""
        s = session()
        for _ in range(settings.continuity_anchor_frames):
            s.offer_frame(frame(10), score=1.0, sharpness=100.0)
        for _ in range(3):
            s.offer_frame(frame(200), score=2.0, sharpness=100.0)
        return s

    def _unit(self, *values):
        v = np.zeros(512, dtype=np.float32)
        v[: len(values)] = values
        return v / np.linalg.norm(v)

    def test_the_same_person_passes(self, monkeypatch):
        # Two views seconds apart in one light through one lens are far more
        # alike than a person is to their own enrolled template from another
        # day, and those already score 0.87 to 0.89.
        s = self._prepared()
        app = self._stub(monkeypatch, self._unit(1.0, 0.05), self._unit(1.0, 0.1))

        assert app._same_face_throughout(s) is True
        assert s.continuity_score > settings.continuity_threshold
        assert s.liveness.status is LivenessStatus.IN_PROGRESS

    def test_a_swap_is_caught(self, monkeypatch):
        # The attack this exists for: pass the challenge, then hold up a
        # photograph of somebody else before the frame that decides identity.
        s = self._prepared()
        app = self._stub(monkeypatch, self._unit(1.0), self._unit(0.0, 1.0))

        assert app._same_face_throughout(s) is False
        assert s.liveness.status is LivenessStatus.FAILED
        assert s.liveness.failure_reason == "identity_changed"
        assert s.continuity_score < settings.continuity_threshold

    def test_a_session_too_short_to_judge_is_allowed_through(self, monkeypatch):
        # Refusing on the absence of evidence would turn a quick scan into a
        # failure, and there is nothing here for an attacker to arrange: a
        # session this short never left the anchor window.
        s = session()
        s.offer_frame(frame(10), score=1.0, sharpness=100.0)
        app = self._stub(monkeypatch, self._unit(1.0), self._unit(1.0))

        assert app._same_face_throughout(s) is True
        assert s.continuity_score is None

    def test_a_frame_with_no_usable_face_says_nothing_either_way(self, monkeypatch):
        import app

        s = self._prepared()
        monkeypatch.setattr(app, "_single_usable_face", lambda _f: (None, "no_face"))

        assert app._same_face_throughout(s) is True
        assert s.continuity_score is None

    def test_it_can_be_recorded_without_enforcing(self, monkeypatch):
        # The measurement is worth having before the refusal is trusted, and
        # the score is written down either way.
        monkeypatch.setattr(settings, "continuity_enforce", False)
        s = self._prepared()
        app = self._stub(monkeypatch, self._unit(1.0), self._unit(0.0, 1.0))

        assert app._same_face_throughout(s) is True
        assert s.continuity_score < settings.continuity_threshold
        assert s.liveness.status is LivenessStatus.IN_PROGRESS

    def test_switching_it_off_skips_the_work_entirely(self, monkeypatch):
        monkeypatch.setattr(settings, "identity_continuity", False)
        s = self._prepared()
        app = self._stub(monkeypatch, self._unit(1.0), self._unit(0.0, 1.0))

        assert app._same_face_throughout(s) is True
        assert s.continuity_score is None
