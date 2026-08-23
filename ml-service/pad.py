"""Presentation attack detection: is this a face, or a picture of one?

Two MiniFASNets from minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0),
converted to ONNX. 3.4MB together, running on the ONNX Runtime already loaded
for ArcFace, so nothing new is installed.

Why this and not something hand-built. Two passive checks were tried before it
and both were measured and abandoned: a planar-versus-3D test on the landmark
mesh, and gaze/eyelid micromotion. Both measured *geometry* -- where landmarks
sit -- and both drowned in the landmark noise of a moving image, at error rates
no till could live with. These models look at pixels instead: ink on paper, a
display's pixel grid, light scattered under real skin. That is a different
signal, and it is not the one landmark noise destroys.

Three classes, not two: paper photo, real face, screen photo. Knowing which
attack was presented is what tells a shopkeeper what to say.

The crop is the whole thing
---------------------------
The numbers in the model filenames are bounding-box expansion factors, 2.7 and
4.0, and each model was trained on a crop of its own size around the face. It
is not a preference. Run one on a tighter crop and it still answers, still
confidently, and the answer means nothing.

The reference clamps the expansion to the image edge when it will not fit, and
that clamp is silent. It is also the normal path rather than an edge case: on
the reference project's own sample images every one clamps, landing between
1.90 and 2.62, and the models classify them correctly there. So clamping is not
in itself a problem, and refusing to run without the full expansion would
refuse everything.

Clamping *far* down is a different matter. The one reference sample the models
get wrong -- a printout held close to the lens, read as real -- is also the only
one whose crop collapses to 1.21. Everything that works sits near 2.0 or above.

So the rule is a floor, not an exact fit. Below `pad_min_crop_scale` there is no
verdict at all: `available` comes back False and the caller must not read that
as either outcome. The achieved scale is reported either way, so the floor can
be moved once a real camera has produced numbers.

The framing that follows: a face at 38-50% of frame height is what the working
samples have, which is why the kiosk guide is sized to put it there. Filling the
frame with a face is what drives the crop down to 1.2.
"""

import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from config import settings

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models" / "anti_spoof"

# name -> the bounding-box expansion the model was trained with
MODELS = {
    "2.7_80x80_MiniFASNetV2.onnx": 2.7,
    "4_0_0_80x80_MiniFASNetV1SE.onnx": 4.0,
}

LABELS = ("paper photo", "real face", "screen photo")
REAL_CLASS = 1
INPUT_SIZE = (80, 80)

_lock = threading.Lock()
_sessions: list[tuple[object, str, float]] | None = None


@dataclass(frozen=True)
class SpoofVerdict:
    """What the models concluded, and whether they were able to conclude it."""

    available: bool
    real_score: float
    label: int
    label_text: str
    models_used: int
    # How far the crop actually expanded. Reported always, so the floor above
    # can be moved once there are numbers from the camera this runs on.
    crop_scale: float = 0.0
    reason: str | None = None

    @property
    def is_attack(self) -> bool:
        """Only ever true when there was enough of a crop to judge from."""
        return self.available and self.real_score < settings.pad_threshold


def models_present() -> bool:
    return all((MODEL_DIR / name).is_file() for name in MODELS)


def _load():
    global _sessions
    if _sessions is not None:
        return _sessions

    with _lock:
        if _sessions is not None:
            return _sessions

        import onnxruntime as ort

        loaded = []
        for name, scale in MODELS.items():
            path = MODEL_DIR / name
            if not path.is_file():
                raise FileNotFoundError(
                    f"missing {path}. Run: python setup_pad_models.py"
                )
            loaded.append(
                (
                    ort.InferenceSession(
                        str(path), providers=["CPUExecutionProvider"]
                    ),
                    name,
                    scale,
                )
            )
        _sessions = loaded
    return _sessions


def warm_up() -> None:
    """Load at startup so the first payment does not pay for it."""
    if settings.pad_enabled and models_present():
        _load()


def _expand(width: int, height: int, bbox, scale: float):
    """The reference crop, plus the scale it actually achieved.

    Returns (box, achieved), or None for a degenerate face box. `achieved` is
    the requested scale or whatever the frame allowed, whichever is smaller --
    reported rather than hidden, because how far it fell is the difference
    between a crop these models handle and one that starves them.
    """
    x1, y1, x2, y2 = bbox
    box_w, box_h = x2 - x1, y2 - y1
    if box_w <= 0 or box_h <= 0:
        return None

    scale = min((height - 1) / box_h, (width - 1) / box_w, scale)
    new_w, new_h = box_w * scale, box_h * scale
    cx, cy = x1 + box_w / 2, y1 + box_h / 2

    left, top = cx - new_w / 2, cy - new_h / 2
    right, bottom = cx + new_w / 2, cy + new_h / 2

    # Shift back inside rather than clip, so the face keeps its scale within
    # the crop even when it sits near an edge -- which is exactly where a
    # held-up photograph tends to be.
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > width - 1:
        left -= right - width + 1
        right = width - 1
    if bottom > height - 1:
        top -= bottom - height + 1
        bottom = height - 1

    return (int(left), int(top), int(right), int(bottom)), scale


def assess(bgr: np.ndarray, bbox) -> SpoofVerdict:
    """Judge one face. `bbox` is (x1, y1, x2, y2) from the detector."""
    if not settings.pad_enabled:
        return SpoofVerdict(False, 0.0, REAL_CLASS, "disabled", 0, 0.0, "pad_disabled")
    if not models_present():
        return SpoofVerdict(False, 0.0, REAL_CLASS, "unavailable", 0, 0.0, "models_missing")

    height, width = bgr.shape[:2]
    totals = np.zeros(3, dtype=np.float64)
    used = 0
    worst_scale = float("inf")

    for session, _name, scale in _load():
        expanded = _expand(width, height, bbox, scale)
        if expanded is None:
            continue

        (left, top, right, bottom), achieved = expanded
        worst_scale = min(worst_scale, achieved)

        crop = bgr[top : bottom + 1, left : right + 1]
        if crop.size == 0:
            continue

        # BGR and 0-255, both as trained. The models came from cv2.imread
        # frames, so converting to RGB would swap two channels of a model whose
        # entire signal is colour, and rescaling would move it off its range.
        resized = cv2.resize(crop, INPUT_SIZE).astype(np.float32)
        batch = np.expand_dims(np.transpose(resized, (2, 0, 1)), 0)

        logits = session.run(None, {session.get_inputs()[0].name: batch})[0]
        shifted = np.exp(logits - logits.max(axis=1, keepdims=True))
        totals += (shifted / shifted.sum(axis=1, keepdims=True))[0]
        used += 1

    if used == 0:
        return SpoofVerdict(
            False, 0.0, REAL_CLASS, "no_context", 0, 0.0, "no_usable_crop"
        )

    # A crop this far below what the models want means a face filling the
    # frame, and that is where the one reference sample they get wrong sits.
    # Better to decline than to answer from it.
    if worst_scale < settings.pad_min_crop_scale:
        return SpoofVerdict(
            False,
            0.0,
            REAL_CLASS,
            "no_context",
            used,
            round(worst_scale, 2),
            "face_too_large_for_crop",
        )

    scores = totals / used
    label = int(np.argmax(scores))

    # The verdict is a threshold on the real-class score, not argmax. Argmax is
    # what the reference does and it is the weaker reading: on the project's own
    # sample images a held printout scores 0.728 real, which argmax calls real
    # and a threshold catches.
    return SpoofVerdict(
        available=True,
        real_score=round(float(scores[REAL_CLASS]), 4),
        label=label,
        label_text=LABELS[label],
        models_used=used,
        crop_scale=round(worst_scale, 2),
    )
