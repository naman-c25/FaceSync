"""Face embedding extraction and 1:N identification.

The system runs 1:N identification, not 1:1 verification: a customer walks up
and presents nothing but their face, so the service has to work out *who* they
are rather than confirm a claim. That makes the matching rule stricter than a
plain threshold comparison — see `identify` for why.
"""

import base64
import threading
from dataclasses import dataclass
from enum import Enum

import numpy as np

from config import settings

# InsightFace pulls in ONNX Runtime and loads ~300MB of models, so it is
# imported lazily inside the loader rather than at module import time. This
# keeps `import recognition` cheap for tests that never touch a real model.
_model_lock = threading.Lock()
_model = None

EMBEDDING_DIM = 512


class MatchDecision(str, Enum):
    MATCHED = "matched"
    NO_MATCH = "no_match"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True)
class DetectedFace:
    """One face found in a frame, with everything downstream stages need."""

    embedding: np.ndarray  # L2-normalised, shape (512,)
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2
    det_score: float
    keypoints: np.ndarray  # shape (5, 2) — eyes, nose, mouth corners

    @property
    def height(self) -> int:
        return self.bbox[3] - self.bbox[1]

    @property
    def bbox_area(self) -> int:
        """Only ever compared against another face in the same frame."""
        return max(self.bbox[2] - self.bbox[0], 0) * max(self.height, 0)


@dataclass(frozen=True)
class GalleryEntry:
    """One enrolled identity to compare against."""

    user_id: str
    embedding: np.ndarray


@dataclass(frozen=True)
class Candidate:
    user_id: str
    score: float


@dataclass(frozen=True)
class MatchResult:
    """The outcome of one identification attempt.

    Carries the runner-up score as well as the winner, because the audit log
    needs both to make FAR/FRR analysis and threshold tuning possible after
    the fact.
    """

    decision: MatchDecision
    user_id: str | None
    top_score: float
    runner_up_score: float
    margin: float
    gallery_size: int
    candidates: list[Candidate]


def _get_model():
    """Load the InsightFace model pack once, on first use."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from insightface.app import FaceAnalysis

                app = FaceAnalysis(
                    name=settings.insightface_model,
                    root=settings.insightface_root,
                    providers=["CPUExecutionProvider"],
                    # buffalo_l also ships gender/age and two dense landmark
                    # models. Nothing here uses them, and they would run on
                    # every detected face — so they are left unloaded. Facial
                    # geometry comes from MediaPipe (see face_detection.py).
                    allowed_modules=["detection", "recognition"],
                )
                app.prepare(
                    ctx_id=-1,
                    det_size=(settings.det_size, settings.det_size),
                    det_thresh=settings.det_score_threshold,
                )
                _model = app
    return _model


def warm_up() -> None:
    """Force model load at startup so the first real request is not slow."""
    _get_model()


def detect_faces(bgr: np.ndarray) -> list[DetectedFace]:
    """Detect every face in a frame and embed each one.

    InsightFace handles detection, five-point alignment and embedding in a
    single pass, and returns embeddings that are already L2-normalised — which
    is what lets cosine similarity below reduce to a plain dot product.
    """
    faces = _get_model().get(bgr)

    return [
        DetectedFace(
            embedding=np.asarray(face.normed_embedding, dtype=np.float32),
            bbox=tuple(int(v) for v in face.bbox),
            det_score=float(face.det_score),
            keypoints=np.asarray(face.kps, dtype=np.float32),
        )
        for face in faces
    ]


def cosine_similarity(probe: np.ndarray, gallery_matrix: np.ndarray) -> np.ndarray:
    """Similarity of one probe against every row of a gallery matrix.

    Both sides are unit vectors, so the dot product *is* the cosine similarity
    and the whole 1:N comparison collapses to a single matrix multiply. On a
    hackathon-sized gallery this costs well under a millisecond, which is why
    the design does not need a vector database yet.
    """
    if gallery_matrix.size == 0:
        return np.empty(0, dtype=np.float32)
    return gallery_matrix @ probe


def identify(
    probe: np.ndarray,
    gallery: list[GalleryEntry],
    *,
    threshold: float | None = None,
    margin: float | None = None,
) -> MatchResult:
    """Work out which enrolled user a probe embedding belongs to.

    `gallery` is the candidate pool, not necessarily every enrolled user. At
    demo scale it is everyone; in production the caller narrows it first (by
    merchant locality, recent activity, or repeat-customer history) so that N
    stays small as the user base grows.

    Two conditions must hold for a match, and the second one is the one people
    forget:

    1. The best score clears `threshold` — this is the same test a 1:1 system
       would apply.
    2. The best score beats the runner-up by `margin`. In 1:N every extra
       enrolled user is another chance to be confused with someone else, so if
       the top two candidates are near-tied the system genuinely does not know
       which of them is standing there. Returning the higher score would be a
       coin flip dressed up as a decision, so this returns AMBIGUOUS instead
       and lets the caller fall back to a second factor.
    """
    threshold = settings.match_threshold if threshold is None else threshold
    margin = settings.match_margin if margin is None else margin

    if not gallery:
        return MatchResult(
            decision=MatchDecision.NO_MATCH,
            user_id=None,
            top_score=0.0,
            runner_up_score=0.0,
            margin=0.0,
            gallery_size=0,
            candidates=[],
        )

    matrix = np.stack([entry.embedding for entry in gallery])
    scores = cosine_similarity(probe, matrix)

    # Rank the whole gallery, then keep a short head for the audit log.
    order = np.argsort(scores)[::-1]
    candidates = [
        Candidate(user_id=gallery[i].user_id, score=round(float(scores[i]), 4))
        for i in order[:5]
    ]

    top_score = float(scores[order[0]])
    runner_up_score = float(scores[order[1]]) if len(gallery) > 1 else 0.0
    observed_margin = top_score - runner_up_score

    if top_score < threshold:
        decision = MatchDecision.NO_MATCH
        user_id = None
    elif len(gallery) > 1 and observed_margin < margin:
        decision = MatchDecision.AMBIGUOUS
        user_id = None
    else:
        decision = MatchDecision.MATCHED
        user_id = gallery[order[0]].user_id

    return MatchResult(
        decision=decision,
        user_id=user_id,
        top_score=round(top_score, 4),
        runner_up_score=round(runner_up_score, 4),
        margin=round(observed_margin, 4),
        gallery_size=len(gallery),
        candidates=candidates,
    )


def build_enrollment_embedding(
    embeddings: list[np.ndarray],
) -> tuple[np.ndarray, list[float]]:
    """Fuse several enrollment samples into one stable representative vector.

    Averaging unit vectors and re-normalising cancels out per-frame noise —
    a slight head turn, a shadow, a moment of motion blur — and leaves the
    part that is consistently *this face*. A single sample would bake whatever
    happened to be true in that one frame into the stored identity.

    Returns the fused embedding plus each sample's similarity to it, so the
    caller can report enrollment quality back to the user.
    """
    if not embeddings:
        raise ValueError("cannot build an embedding from zero samples")

    stacked = np.stack(embeddings).astype(np.float32)
    mean = stacked.mean(axis=0)

    norm = np.linalg.norm(mean)
    if norm == 0:
        raise ValueError("enrollment samples cancelled out to a zero vector")
    fused = (mean / norm).astype(np.float32)

    per_sample_similarity = [round(float(e @ fused), 4) for e in stacked]
    return fused, per_sample_similarity


def find_outlier_samples(
    embeddings: list[np.ndarray], threshold: float | None = None
) -> list[int]:
    """Indices of enrollment samples that look like a different person.

    Enrollment captures several frames at different angles, and the operator
    cannot see embeddings — so a frame that caught a bystander, or a hand over
    the lens, would silently poison the stored identity. Comparing each sample
    against the group mean catches that before it is written to the database.
    """
    threshold = (
        settings.enrollment_consistency_threshold if threshold is None else threshold
    )
    if len(embeddings) < 2:
        return []

    _, similarities = build_enrollment_embedding(embeddings)
    return [i for i, sim in enumerate(similarities) if sim < threshold]


def encode_embedding(embedding: np.ndarray) -> str:
    """Serialise an embedding for transport to the Node layer.

    Base64 of raw float32 rather than a JSON array of numbers: 2KB instead of
    roughly 10KB, and no float-repr rounding on the way through.
    """
    return base64.b64encode(embedding.astype(np.float32).tobytes()).decode("ascii")


def decode_embedding(encoded: str) -> np.ndarray:
    """Inverse of `encode_embedding`."""
    embedding = np.frombuffer(base64.b64decode(encoded), dtype=np.float32)
    if embedding.shape != (EMBEDDING_DIM,):
        raise ValueError(
            f"expected a {EMBEDDING_DIM}-d embedding, got shape {embedding.shape}"
        )
    return embedding
