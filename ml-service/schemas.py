"""Request and response models for the ML service.

These are the contract between the Node orchestration layer and this service.
Frames arrive as base64 rather than multipart because the Node side is already
handling JSON throughout, and a frame at kiosk resolution is small enough that
the ~33% base64 overhead is not worth a second content type.
"""

import base64
import binascii

from pydantic import BaseModel, Field, field_validator

from liveness import LivenessStatus
from recognition import MatchDecision


def _decode_frame(value: str) -> bytes:
    """Accept a bare base64 payload or a full `data:image/...;base64,` URL."""
    if value.startswith("data:"):
        _, _, value = value.partition(",")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_b64 is not valid base64") from exc


class FrameRequest(BaseModel):
    session_id: str
    image_b64: str

    @field_validator("image_b64")
    @classmethod
    def _validate_decodable(cls, value: str) -> str:
        _decode_frame(value)
        return value

    @property
    def image_bytes(self) -> bytes:
        return _decode_frame(self.image_b64)


# -- enrollment --------------------------------------------------------


class EnrollmentStartResponse(BaseModel):
    session_id: str
    samples_required: int
    guidance: list[str]


class EnrollmentCaptureResponse(BaseModel):
    accepted: bool
    samples_collected: int
    samples_required: int
    reason: str | None = None
    sharpness: float | None = None
    detection_score: float | None = None


class EnrollmentFinalizeRequest(BaseModel):
    session_id: str


class EnrollmentFinalizeResponse(BaseModel):
    """The fused identity, ready for Node to encrypt and store.

    The embedding leaves this service in the clear; encryption is the Node
    layer's job because that is where the key material and the database live.
    """

    embedding_b64: str
    samples_used: int
    per_sample_similarity: list[float]
    mean_similarity: float
    outliers_dropped: int


# -- verification ------------------------------------------------------


class VerifyStartResponse(BaseModel):
    session_id: str
    prompt: str
    total_steps: int


class VerifyFrameResponse(BaseModel):
    status: LivenessStatus
    prompt: str | None
    step_index: int
    total_steps: int
    step_progress: float
    failure_reason: str | None = None
    face_detected: bool
    ready_to_match: bool = Field(
        default=False,
        description="Liveness passed and a probe embedding is available.",
    )


class GalleryEntryModel(BaseModel):
    user_id: str
    embedding_b64: str


class MatchRequest(BaseModel):
    """A probe session plus the candidate pool to search.

    `gallery` is not necessarily every enrolled user. Node narrows it first —
    by merchant locality, recent activity, or repeat-customer history — so the
    comparison count stays bounded as enrollment grows. At demo scale it is
    simply everyone.
    """

    session_id: str
    gallery: list[GalleryEntryModel]
    threshold: float | None = None
    margin: float | None = None


class CandidateModel(BaseModel):
    user_id: str
    score: float


class MatchResponse(BaseModel):
    """Carries the runner-up score as well as the winner.

    Both numbers are needed downstream: the audit log uses them to compute
    FAR/FRR and to re-tune thresholds against real attempts after the fact.
    """

    decision: MatchDecision
    user_id: str | None
    top_score: float
    runner_up_score: float
    margin: float
    gallery_size: int
    candidates: list[CandidateModel]


class HealthResponse(BaseModel):
    status: str
    models_loaded: bool
    active_enrollment_sessions: int
    active_verification_sessions: int
