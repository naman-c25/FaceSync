"""A second opinion on whether a face is real, from colour texture.

What it is
----------
Local binary patterns over the *chroma* channels -- HSV and YCbCr -- fed to an
SVM. `tools/train_pad.py` explains the method and fits it; this loads what that
saved and scores one crop.

Why a second model at all
-------------------------
The MiniFASNets are a convolutional read of the same crop, and they are good.
Their weakness is stated by their own authors: "limited robustness to camera
model type and usage scenarios". Measured here, a genuine face scores 0.88-0.99
in daylight and 0.55-0.60 near midnight, against a threshold of 0.70 -- so the
same person is accepted in the afternoon and refused at night. Twenty-six per
cent of all logged attempts fail this way, and almost none of them are attacks.

Raising the threshold to fix that would let screen attacks through: they score
0.45-0.46, which is not far below where genuine faces land in bad light. There
is no single number that separates those two populations, which is precisely
when a second, differently-wrong signal is worth having. This one reads colour
statistics rather than learned convolutional features, so the conditions that
confuse it are not the conditions that confuse a CNN.

Where it is consulted
---------------------
Only in the band where the first model is unsure -- see `pad.combine`. Outside
that band the CNN is confident and this is not asked, which keeps the cost off
the common path and keeps the shipped behaviour unchanged wherever the CNN
already worked.

What it is not
--------------
Trained. There is no model file in this repository and nothing here fabricates
one: it needs `benchmark-data/pad`, which `tools/collect_pad.py` fills from a
real camera with real prints and real screens. Until that exists `available` is
false and every path below degrades to the CNN alone, which is exactly today's
behaviour.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np

from config import BASE_DIR

MODEL_PATH = BASE_DIR / "models" / "pad_texture.joblib"

_lock = threading.Lock()
_model = None
_tried = False


@dataclass(frozen=True)
class TextureVerdict:
    available: bool
    real_score: float = 0.0
    reason: str | None = None


def model_present() -> bool:
    return MODEL_PATH.is_file()


def _load():
    """The fitted pipeline, or None. Tried once; a failure is not retried."""
    global _model, _tried
    if _tried:
        return _model

    with _lock:
        if _tried:
            return _model
        _tried = True

        if not MODEL_PATH.is_file():
            return None

        try:
            import joblib

            _model = joblib.load(MODEL_PATH)
        except Exception as exc:  # noqa: BLE001 -- any failure means no model
            # Never fatal. This is the second opinion; the first still works,
            # and a payment must not fail because an optional model did not
            # load.
            print(f"[pad] texture model at {MODEL_PATH} did not load: {exc}")
            _model = None

    return _model


def reset() -> None:
    """Forget the loaded model, so a test can swap one in."""
    global _model, _tried
    with _lock:
        _model = None
        _tried = False


def assess(crop: np.ndarray) -> TextureVerdict:
    """Probability that `crop` is a real face, from its colour texture.

    `crop` is the same BGR face crop the CNNs were given -- raw, never the
    CLAHE-conditioned frame, since rewriting the lightness channel is exactly
    what destroys the chroma signal this reads.
    """
    model = _load()
    if model is None:
        return TextureVerdict(available=False, reason="no_texture_model")

    try:
        from tools.train_pad import features as chroma_lbp_features

        features = chroma_lbp_features(crop).reshape(1, -1)
        # `predict_proba` puts the positive class second, and the trainer
        # labels real as 1.
        score = float(model.predict_proba(features)[0][1])
    except Exception as exc:  # noqa: BLE001
        return TextureVerdict(available=False, reason=f"texture_failed:{exc}")

    return TextureVerdict(available=True, real_score=round(score, 4))
