"""MediaPipe Face Mesh wrapper — the geometry layer under liveness detection.

InsightFace (see `recognition.py`) gives five facial keypoints, which is enough
to align a face for embedding but nowhere near enough to tell whether an eye is
open. This module runs MediaPipe's FaceLandmarker instead, which returns 478
points including a five-point ring around each iris, and reduces them to the
two signals liveness actually cares about: eye aspect ratio and gaze direction.

MediaPipe 1.0 removed the old `mp.solutions.face_mesh` API, so this uses the
Tasks API and needs `models/face_landmarker.task` on disk (see README).
"""

import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from config import BASE_DIR, settings

MODEL_PATH = BASE_DIR / "models" / "face_landmarker.task"

# Landmark indices into MediaPipe's canonical 478-point face mesh.
#
# Names describe where the feature appears *in the image* for a face looking at
# the camera, not which side of the subject's head it belongs to. An unmirrored
# frame puts the subject's left eye on the image's right, and conflating the
# two is the classic way to ship a gaze check that is backwards.
IMG_LEFT_EYE_CORNERS = (33, 133)  # outer, inner
IMG_LEFT_EYE_VERTICAL = ((160, 144), (158, 153))  # (upper, lower) pairs
IMG_LEFT_EYE_LID = (159, 145)  # upper lid centre, lower lid centre
IMG_LEFT_IRIS_CENTRE = 468

IMG_RIGHT_EYE_CORNERS = (362, 263)  # inner, outer
IMG_RIGHT_EYE_VERTICAL = ((385, 380), (387, 373))
IMG_RIGHT_EYE_LID = (386, 374)
IMG_RIGHT_IRIS_CENTRE = 473

# The iris ring only exists in the refined 478-point output. If a model bundle
# ever returns the bare 468, gaze silently becomes nonsense, so we check.
LANDMARKS_WITH_IRIS = 478

# Two separate locks, deliberately.
#
# `_load_lock` guards the one-time construction of the detector; `_infer_lock`
# serialises calls into it. A single lock covering both would deadlock, because
# `analyse` would be holding it while `_get_detector` tried to take it again —
# and `threading.Lock` is not reentrant. Splitting them also means a slow model
# load does not sit inside the lock that every inference call needs.
_load_lock = threading.Lock()
_infer_lock = threading.Lock()
_detector = None


@dataclass(frozen=True)
class FaceGeometry:
    """Per-frame geometric signals derived from the face mesh."""

    landmarks: np.ndarray  # shape (478, 2), pixel coordinates
    ear: float  # mean eye aspect ratio across both eyes
    ear_left: float
    ear_right: float
    gaze_horizontal: float  # 0.0 = image-left, 0.5 = centre, 1.0 = image-right
    gaze_vertical: float  # 0.0 = image-top, 1.0 = image-bottom


def _get_detector():
    """Create the FaceLandmarker once, on first use."""
    global _detector
    if _detector is None:
        with _load_lock:
            if _detector is None:
                if not MODEL_PATH.exists():
                    raise FileNotFoundError(
                        f"Face mesh model missing at {MODEL_PATH}. "
                        "Run: python setup_models.py"
                    )

                from mediapipe.tasks.python import BaseOptions, vision

                options = vision.FaceLandmarkerOptions(
                    base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
                    # IMAGE mode keeps the detector stateless, so a single
                    # instance can serve concurrent sessions. VIDEO mode would
                    # add temporal smoothing but demands one detector per
                    # session with monotonic timestamps — and the liveness
                    # state machine already does its own analysis over time.
                    running_mode=vision.RunningMode.IMAGE,
                    num_faces=settings.max_faces_in_frame,
                )
                _detector = vision.FaceLandmarker.create_from_options(options)
    return _detector


def warm_up() -> None:
    """Force model load at startup so the first real request is not slow."""
    _get_detector()


def _euclidean(points: np.ndarray, a: int, b: int) -> float:
    return float(np.linalg.norm(points[a] - points[b]))


def eye_aspect_ratio(
    points: np.ndarray,
    corners: tuple[int, int],
    vertical_pairs: tuple[tuple[int, int], tuple[int, int]],
) -> float:
    """Height-to-width ratio of one eye.

    Two vertical measurements averaged against the horizontal span. Dividing by
    the eye's own width is what makes the value comparable across people and
    across distances from the camera — a face closer to the lens has a bigger
    eye in pixels but the same ratio.

    An open eye sits around 0.28-0.35 and collapses below ~0.20 mid-blink.
    """
    width = _euclidean(points, *corners)
    if width == 0:
        return 0.0

    heights = sum(_euclidean(points, upper, lower) for upper, lower in vertical_pairs)
    return heights / (2.0 * width)


def _axis_ratio(points: np.ndarray, iris: int, start: int, end: int) -> float:
    """Where the iris sits along a landmark-to-landmark axis, as 0.0-1.0.

    This projects the iris centre onto the axis vector rather than comparing
    raw x or y coordinates, so a tilted head does not read as a sideways
    glance — the axis tilts with the face.
    """
    axis = points[end] - points[start]
    length_squared = float(axis @ axis)
    if length_squared == 0:
        return 0.5

    offset = points[iris] - points[start]
    return float(np.clip((offset @ axis) / length_squared, 0.0, 1.0))


def analyse(bgr: np.ndarray) -> FaceGeometry | None:
    """Extract EAR and gaze from a frame, or None if no face was found."""
    import mediapipe as mp

    # Resolved before the inference lock is taken — see the note on the locks.
    detector = _get_detector()

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    # MediaPipe's detector is not documented as thread-safe, and FastAPI will
    # happily call this from several worker threads at once.
    with _infer_lock:
        result = detector.detect(image)

    if not result.face_landmarks:
        return None

    height, width = bgr.shape[:2]
    normalised = result.face_landmarks[0]

    if len(normalised) < LANDMARKS_WITH_IRIS:
        raise RuntimeError(
            f"Face mesh returned {len(normalised)} landmarks; gaze needs "
            f"{LANDMARKS_WITH_IRIS}. The model bundle is missing iris refinement."
        )

    points = np.array(
        [(lm.x * width, lm.y * height) for lm in normalised], dtype=np.float32
    )

    ear_left = eye_aspect_ratio(points, IMG_LEFT_EYE_CORNERS, IMG_LEFT_EYE_VERTICAL)
    ear_right = eye_aspect_ratio(points, IMG_RIGHT_EYE_CORNERS, IMG_RIGHT_EYE_VERTICAL)

    # Average the two eyes' gaze. One eye can be partially occluded by a nose
    # bridge or a hair strand at an angle; both being wrong at once is rarer.
    gaze_h = 0.5 * (
        _axis_ratio(points, IMG_LEFT_IRIS_CENTRE, *IMG_LEFT_EYE_CORNERS)
        + _axis_ratio(points, IMG_RIGHT_IRIS_CENTRE, *IMG_RIGHT_EYE_CORNERS)
    )
    gaze_v = 0.5 * (
        _axis_ratio(points, IMG_LEFT_IRIS_CENTRE, *IMG_LEFT_EYE_LID)
        + _axis_ratio(points, IMG_RIGHT_IRIS_CENTRE, *IMG_RIGHT_EYE_LID)
    )

    # Index 33 is the image-left eye's *outer* corner and 133 its inner one, so
    # the axis already runs left-to-right across the image. A mirrored frame
    # reverses that, and flipping the ratio here keeps every downstream
    # comparison written in image-space terms.
    if settings.frames_are_mirrored:
        gaze_h = 1.0 - gaze_h

    return FaceGeometry(
        landmarks=points,
        ear=0.5 * (ear_left + ear_right),
        ear_left=round(ear_left, 4),
        ear_right=round(ear_right, 4),
        gaze_horizontal=round(gaze_h, 4),
        gaze_vertical=round(gaze_v, 4),
    )
