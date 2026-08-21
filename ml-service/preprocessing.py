"""Frame conditioning that runs before anything else looks at the image.

A note on face alignment: the Phase 1 design doc lists alignment as a
preprocessing step. It is not implemented here, on purpose. InsightFace already
applies a similarity transform (`norm_crop`) driven by five facial keypoints
before it computes an embedding, so writing our own aligner would mean the face
gets warped twice — which makes matching worse, not better.

What InsightFace does *not* do is fix bad lighting on the input frame, so that
is what this module handles: lighting normalisation plus the quality gates that
stop a hopeless frame from reaching the expensive part of the pipeline.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from config import settings


@dataclass(frozen=True)
class FrameQuality:
    """Why a frame was accepted or rejected, in a form worth logging."""

    acceptable: bool
    sharpness: float
    brightness: float
    reason: str | None = None


def normalize_lighting(bgr: np.ndarray) -> np.ndarray:
    """Even out illumination so a dim frame and a bright frame stay comparable.

    CLAHE is applied only to the L (lightness) channel in LAB space. Running it
    on the BGR channels directly would shift the colour balance and change how
    the face looks, which is exactly what we are trying to avoid.
    """
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    lightness, a_channel, b_channel = cv2.split(lab)

    clahe = cv2.createCLAHE(
        clipLimit=settings.clahe_clip_limit,
        tileGridSize=(settings.clahe_tile_grid_size, settings.clahe_tile_grid_size),
    )
    lightness = clahe.apply(lightness)

    return cv2.cvtColor(cv2.merge((lightness, a_channel, b_channel)), cv2.COLOR_LAB2BGR)


def measure_sharpness(bgr: np.ndarray) -> float:
    """Variance of the Laplacian — the standard cheap blur estimate.

    A sharp image has strong second derivatives at edges and therefore high
    variance. Motion blur and out-of-focus frames collapse it toward zero.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def measure_brightness(bgr: np.ndarray) -> float:
    """Mean luminance on a 0-255 scale."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return float(gray.mean())


def assess_frame(bgr: np.ndarray) -> FrameQuality:
    """Gate a raw frame before detection runs.

    Cheap checks first. A blurry or near-black frame cannot produce a
    trustworthy embedding, and letting it through would just add noise to the
    similarity scores we are about to tune thresholds against.
    """
    sharpness = measure_sharpness(bgr)
    brightness = measure_brightness(bgr)

    if sharpness < settings.min_sharpness:
        return FrameQuality(False, sharpness, brightness, "frame_too_blurry")

    # These bounds are deliberately wide — CLAHE recovers a lot. They only
    # catch frames where the sensor has genuinely clipped and there is no
    # detail left to recover.
    if brightness < 25.0:
        return FrameQuality(False, sharpness, brightness, "frame_too_dark")
    if brightness > 235.0:
        return FrameQuality(False, sharpness, brightness, "frame_overexposed")

    return FrameQuality(True, sharpness, brightness)


def decode_image(raw: bytes) -> np.ndarray | None:
    """Decode JPEG/PNG bytes into a BGR array, or None if the bytes are junk."""
    buffer = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    return image if image is not None and image.size else None
