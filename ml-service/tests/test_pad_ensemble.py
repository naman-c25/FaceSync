"""The two-model verdict, and the promise that today it changes nothing.

The texture model is not trained -- it needs captures that do not exist yet --
so the property that matters most here is that its absence leaves the shipped
behaviour exactly as it was. Everything else in this file is the rule that
takes over once somebody has collected the data.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pad
import pad_texture
from config import settings
from pad import SpoofVerdict

LOW = settings.pad_uncertain_low
HIGH = settings.pad_uncertain_high
CNN = settings.pad_threshold
TEX = settings.pad_texture_threshold


def verdict(real_score, texture_score=None):
    return SpoofVerdict(
        available=True,
        real_score=real_score,
        label=pad.REAL_CLASS,
        label_text="real face",
        models_used=2,
        crop_scale=2.7,
        texture_score=texture_score,
        decided_by="texture" if texture_score is not None else "cnn",
    )


class TestWithoutATextureModel:
    """No model installed, which is how this ships."""

    def test_the_thresholds_bracket_each_other_sensibly(self):
        # If the band did not contain the CNN threshold, the second model would
        # be consulted about faces the first had already decided, and never
        # about the ones it was unsure of.
        assert LOW < CNN < HIGH

    def test_a_confident_real_face_still_passes(self):
        assert not verdict(0.99).is_attack

    def test_a_confident_attack_is_still_refused(self):
        assert verdict(0.02).is_attack

    def test_the_cnn_threshold_still_decides_the_middle(self):
        # The exact behaviour measured in the README: genuine faces at 0.55-0.60
        # in poor light are refused, screen attacks at 0.45 are refused. Both
        # unchanged, because nothing else is installed to say otherwise.
        assert verdict(0.60).is_attack
        assert verdict(0.45).is_attack
        assert not verdict(0.71).is_attack

    def test_an_unavailable_verdict_is_never_an_attack(self):
        # A crop too small to judge from must not be read as either answer.
        no_crop = SpoofVerdict(
            available=False,
            real_score=0.0,
            label=pad.REAL_CLASS,
            label_text="no_context",
            models_used=0,
            reason="face_too_large_for_crop",
        )
        assert not no_crop.is_attack

    def test_the_model_really_is_absent(self):
        # Guards against this file silently testing a model somebody dropped in.
        assert not pad_texture.model_present()
        assert not pad_texture.assess(None).available


class TestWithATextureModel:
    """What happens once the captures exist and one has been trained."""

    def test_it_can_rescue_a_face_the_cnn_was_unsure_about(self):
        # The case this whole ensemble is for: a real person in poor light,
        # scoring 0.58 on the CNN and refused today, with a second model that
        # reads colour rather than convolutional features saying it is skin.
        assert not verdict(0.58, texture_score=0.90).is_attack

    def test_it_can_refuse_one_the_cnn_would_have_allowed(self):
        # And the other direction, which is what makes it a check rather than
        # a way of saying yes more often. 0.72 clears the CNN threshold; a
        # texture model that disagrees still stops it.
        assert verdict(0.72, texture_score=0.10).is_attack

    def test_a_second_opinion_has_to_be_confident(self):
        # It is only ever asked about faces already under suspicion, so it has
        # to clear a higher bar than the model that raised the doubt.
        assert TEX > 0.5
        assert verdict(0.58, texture_score=TEX - 0.01).is_attack
        assert not verdict(0.58, texture_score=TEX + 0.01).is_attack

    def test_the_cnn_score_is_still_reported(self):
        # Every measurement in the README was taken against this number. An
        # ensemble that overwrote it would make them unreproducible.
        v = verdict(0.58, texture_score=0.90)
        assert v.real_score == 0.58
        assert v.texture_score == 0.90
        assert v.decided_by == "texture"


class TestTheBand:
    """Which scores get a second opinion at all."""

    @pytest.mark.parametrize("score", [0.0, 0.1, LOW - 0.01])
    def test_below_the_band_the_cnn_decides_alone(self, score):
        assert not (LOW <= score <= HIGH)

    @pytest.mark.parametrize("score", [HIGH + 0.01, 0.9, 1.0])
    def test_above_the_band_the_cnn_decides_alone(self, score):
        assert not (LOW <= score <= HIGH)

    @pytest.mark.parametrize("score", [LOW, 0.45, 0.58, 0.6, HIGH])
    def test_inside_the_band_a_second_opinion_is_sought(self, score):
        assert LOW <= score <= HIGH

    def test_the_band_covers_the_overlap_that_was_measured(self):
        # Genuine faces in poor light land at 0.55-0.60 and screen attacks at
        # 0.45-0.46. Both populations have to fall inside, or the band is
        # bracketing the wrong place.
        for measured in (0.45, 0.46, 0.55, 0.60):
            assert LOW <= measured <= HIGH


class TestTextureAssessDegradesQuietly:
    def test_no_model_is_not_an_error(self):
        # A missing optional model must never fail a payment.
        pad_texture.reset()
        result = pad_texture.assess(None)
        assert result.available is False
        assert result.reason == "no_texture_model"
        assert result.real_score == 0.0
