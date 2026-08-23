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


class CapturedFrame(BaseModel):
    """One frame, with the moment it was taken.

    The capture time is the point of this. Frames arrive in batches because the
    network cannot carry them one at a time fast enough, so the instant a
    request lands says nothing about when the frames in it were taken — and the
    blink window is measured in milliseconds. Timing them by arrival would
    compress a whole batch into one instant and make every blink unmeasurable.
    """

    image_b64: str
    captured_at_ms: float

    @field_validator("image_b64")
    @classmethod
    def _validate_decodable(cls, value: str) -> str:
        _decode_frame(value)
        return value

    @property
    def image_bytes(self) -> bytes:
        return _decode_frame(self.image_b64)


class FrameBatchRequest(BaseModel):
    """Several consecutive frames from one capture run.

    A browser can capture at 15fps but only ship 3-5fps to a server over a
    tunnel. Sending one frame per request ties the sampling rate to the round
    trip, and a 250ms blink then falls entirely between two samples — which is
    exactly why gaze challenges passed and blink challenges did not. Batching
    decouples the two.
    """

    session_id: str
    frames: list[CapturedFrame] = Field(min_length=1, max_length=12)


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


class LivenessSignalsModel(BaseModel):
    """Everything the challenge measured, for the caller's audit log.

    Returned only once a session reaches a verdict. Sending it on every frame
    would multiply the response size across a whole capture for data nobody
    reads until the end.
    """

    frames_processed: int
    frames_without_face: int
    frames_ear_unusable: int
    frames_crowded: int = 0
    blinks_detected: int
    ear_min: float | None = None
    ear_max: float | None = None
    ear_open_baseline: float | None = None
    ear_threshold_used: float | None = None
    gaze_min: float | None = None
    gaze_max: float | None = None
    yaw_min: float | None = None
    yaw_max: float | None = None
    head_motion_px: float
    elapsed_seconds: float
    challenge: list[str]

    # Per-step evidence for look challenges. The session-wide gaze and yaw
    # ranges above say how far the head moved, but not from where, nor which
    # way relative to what was asked -- which is what made a wrong-direction
    # pass impossible to diagnose from a log and had to be reasoned about
    # instead. `baseline_retries` counts rest windows rejected for not being
    # still, so a person who never settles is distinguishable from one who
    # never moves.
    baseline_retries: int = 0
    baselines_locked: list = Field(default_factory=list)
    step_shifts: list = Field(default_factory=list)
    longest_blink_ms: float = 0.0
    effective_fps: float | None = Field(
        default=None,
        description=(
            "Frames per second actually sampled. Below about 8 a blink starts "
            "falling between samples, so a session that failed on a blink is "
            "worth reading against this before touching any threshold."
        ),
    )


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
    signals: LivenessSignalsModel | None = Field(
        default=None,
        description="Present once the session has passed or failed, not before.",
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


class CompareRequest(BaseModel):
    """Match a loose embedding against a gallery, with no session involved.

    Used at the end of enrollment to ask "is this person already registered?".
    That question has no liveness step — the frames it came from already passed
    the enrollment quality gates — so it cannot go through /verify/match, which
    deliberately refuses to run without one.
    """

    embedding_b64: str
    gallery: list[GalleryEntryModel]
    threshold: float | None = None
    margin: float | None = None


class CompareResponse(BaseModel):
    decision: MatchDecision
    user_id: str | None
    top_score: float
    runner_up_score: float
    margin: float
    gallery_size: int
    candidates: list[CandidateModel]


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

    probe_embedding_b64: str = Field(
        description=(
            "The embedding this attempt was matched on. Returned so the caller "
            "can retain it when an attempt fails, which is what makes it "
            "possible to recognise the same unidentified face turning up "
            "repeatedly across merchants."
        ),
    )
    signals: LivenessSignalsModel


class HealthResponse(BaseModel):
    status: str
    models_loaded: bool
    active_enrollment_sessions: int
    active_verification_sessions: int
