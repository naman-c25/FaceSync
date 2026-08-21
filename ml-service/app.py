"""FastAPI entrypoint for the face recognition and liveness service.

This service does the ML and nothing else. It holds no database connection, no
encryption keys and no user records — the Node layer owns all of that and calls
in here with frames, then with a candidate pool to match against.

Endpoints are declared with `def` rather than `async def` on purpose. Model
inference is blocking CPU work, and FastAPI runs sync endpoints in a worker
threadpool; declaring them async would run that blocking work directly on the
event loop and stall every other request in flight.
"""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException

import face_detection
import preprocessing
import recognition
from config import settings
from liveness import LivenessSession, LivenessStatus
from schemas import (
    CandidateModel,
    EnrollmentCaptureResponse,
    EnrollmentFinalizeRequest,
    EnrollmentFinalizeResponse,
    EnrollmentStartResponse,
    FrameRequest,
    HealthResponse,
    MatchRequest,
    MatchResponse,
    VerifyFrameResponse,
    VerifyStartResponse,
)
from session_store import (
    EnrollmentSession,
    VerificationSession,
    enrollment_sessions,
    frame_quality_score,
    verification_sessions,
)

logger = logging.getLogger("facepay.ml")

ENROLLMENT_GUIDANCE = [
    "Look straight at the camera",
    "Turn your head slightly left",
    "Turn your head slightly right",
    "Tilt your chin slightly up",
    "Tilt your chin slightly down",
    "Look straight ahead once more",
]

_models_ready = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load models up front and sweep dead sessions in the background."""
    global _models_ready
    loop = asyncio.get_running_loop()
    try:
        # First run downloads the InsightFace pack (~300MB), so this is pushed
        # off the event loop rather than blocking startup handling.
        await loop.run_in_executor(None, recognition.warm_up)
        await loop.run_in_executor(None, face_detection.warm_up)
        _models_ready = True
        logger.info("models loaded")
    except Exception:
        # A failed warm-up must not take the service down — /health reports it
        # and the first real request will surface the underlying error.
        logger.exception("model warm-up failed; will retry on first request")

    sweeper = asyncio.create_task(_sweep_sessions())
    try:
        yield
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper


async def _sweep_sessions() -> None:
    """Evict expired sessions so abandoned kiosk attempts do not accumulate."""
    while True:
        await asyncio.sleep(60)
        dropped = enrollment_sessions.purge_expired()
        dropped += verification_sessions.purge_expired()
        if dropped:
            logger.info("purged %d expired sessions", dropped)


app = FastAPI(
    title="FacePay ML Service",
    version="0.1.0",
    description="Face detection, liveness and 1:N identification.",
    lifespan=lifespan,
)


# -- shared frame handling ---------------------------------------------


def _prepare_frame(request: FrameRequest) -> tuple[np.ndarray | None, str | None, float]:
    """Decode and condition one frame.

    Returns (frame, rejection_reason, sharpness). Enrollment and verification
    both go through here so that a face is preprocessed identically at both
    ends — CLAHE applied during enrollment but not verification would shift the
    embeddings apart and quietly wreck every similarity score.
    """
    image = preprocessing.decode_image(request.image_bytes)
    if image is None:
        return None, "undecodable_image", 0.0

    quality = preprocessing.assess_frame(image)
    if not quality.acceptable:
        return None, quality.reason, quality.sharpness

    return preprocessing.normalize_lighting(image), None, quality.sharpness


def _single_usable_face(
    frame: np.ndarray,
) -> tuple[recognition.DetectedFace | None, str | None]:
    """Detect exactly one face, large and confident enough to trust."""
    faces = recognition.detect_faces(frame)

    if not faces:
        return None, "no_face_detected"
    if len(faces) > settings.max_faces_in_frame:
        # At a kiosk an extra face in view makes it genuinely unclear who is
        # paying, so this rejects rather than guessing at the largest one.
        return None, "multiple_faces_detected"

    face = faces[0]
    if face.det_score < settings.det_score_threshold:
        return None, "low_detection_confidence"
    if face.height < settings.min_face_height_ratio * frame.shape[0]:
        return None, "face_too_small"

    return face, None


# -- health ------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        models_loaded=_models_ready,
        active_enrollment_sessions=len(enrollment_sessions),
        active_verification_sessions=len(verification_sessions),
    )


# -- enrollment --------------------------------------------------------


@app.post("/enroll/start", response_model=EnrollmentStartResponse)
def enroll_start() -> EnrollmentStartResponse:
    session = enrollment_sessions.put(
        EnrollmentSession(session_id=enrollment_sessions.new_id())
    )
    return EnrollmentStartResponse(
        session_id=session.session_id,
        samples_required=settings.min_enrollment_samples,
        guidance=ENROLLMENT_GUIDANCE[: settings.max_enrollment_samples],
    )


@app.post("/enroll/capture", response_model=EnrollmentCaptureResponse)
def enroll_capture(request: FrameRequest) -> EnrollmentCaptureResponse:
    """Take one enrollment sample.

    Samples are rejected freely here. Enrollment happens once and the user is
    standing right there, so asking for another frame costs a second — whereas
    a bad sample averaged into the stored identity degrades every future match.
    """
    session = enrollment_sessions.get(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="unknown or expired session")

    if len(session.samples) >= settings.max_enrollment_samples:
        raise HTTPException(status_code=409, detail="enrollment already has enough samples")

    frame, reason, sharpness = _prepare_frame(request)
    if frame is None:
        session.rejected_frames += 1
        return EnrollmentCaptureResponse(
            accepted=False,
            samples_collected=len(session.samples),
            samples_required=settings.min_enrollment_samples,
            reason=reason,
            sharpness=round(sharpness, 2),
        )

    face, reason = _single_usable_face(frame)
    if face is None:
        session.rejected_frames += 1
        return EnrollmentCaptureResponse(
            accepted=False,
            samples_collected=len(session.samples),
            samples_required=settings.min_enrollment_samples,
            reason=reason,
            sharpness=round(sharpness, 2),
        )

    session.samples.append(face.embedding)
    return EnrollmentCaptureResponse(
        accepted=True,
        samples_collected=len(session.samples),
        samples_required=settings.min_enrollment_samples,
        sharpness=round(sharpness, 2),
        detection_score=round(face.det_score, 4),
    )


@app.post("/enroll/finalize", response_model=EnrollmentFinalizeResponse)
def enroll_finalize(request: EnrollmentFinalizeRequest) -> EnrollmentFinalizeResponse:
    """Fuse the collected samples into the single embedding that gets stored."""
    session = enrollment_sessions.get(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="unknown or expired session")

    if len(session.samples) < settings.min_enrollment_samples:
        raise HTTPException(
            status_code=400,
            detail=(
                f"need at least {settings.min_enrollment_samples} samples, "
                f"have {len(session.samples)}"
            ),
        )

    # Drop samples that disagree with the group before fusing. A frame that
    # caught a bystander would otherwise be averaged into the stored identity,
    # silently pulling it toward a face that is not the user's.
    outliers = set(recognition.find_outlier_samples(session.samples))
    kept = [e for i, e in enumerate(session.samples) if i not in outliers]

    if len(kept) < settings.min_enrollment_samples:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{len(outliers)} samples were inconsistent with the rest; "
                "re-run enrollment with only one person in frame"
            ),
        )

    embedding, similarities = recognition.build_enrollment_embedding(kept)
    enrollment_sessions.discard(request.session_id)

    return EnrollmentFinalizeResponse(
        embedding_b64=recognition.encode_embedding(embedding),
        samples_used=len(kept),
        per_sample_similarity=similarities,
        mean_similarity=round(sum(similarities) / len(similarities), 4),
        outliers_dropped=len(outliers),
    )


# -- verification ------------------------------------------------------


@app.post("/verify/start", response_model=VerifyStartResponse)
def verify_start() -> VerifyStartResponse:
    """Open a verification session with a freshly randomised challenge."""
    session_id = verification_sessions.new_id()
    session = verification_sessions.put(
        VerificationSession(
            session_id=session_id, liveness=LivenessSession(session_id=session_id)
        )
    )
    return VerifyStartResponse(
        session_id=session.session_id,
        prompt=session.liveness.prompt or "",
        total_steps=len(session.liveness.challenge),
    )


@app.post("/verify/frame", response_model=VerifyFrameResponse)
def verify_frame(request: FrameRequest) -> VerifyFrameResponse:
    """Feed one frame into the liveness challenge.

    Only MediaPipe runs per frame. The far more expensive ArcFace pass happens
    once, after liveness has passed — which is the whole point of checking
    liveness first.
    """
    session = verification_sessions.get(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="unknown or expired session")

    if session.liveness.status is not LivenessStatus.IN_PROGRESS:
        return _verify_response(session, face_detected=False)

    frame, _, sharpness = _prepare_frame(request)
    geometry = face_detection.analyse(frame) if frame is not None else None

    if frame is not None and geometry is not None:
        session.offer_frame(frame, frame_quality_score(geometry, sharpness))

    session.liveness.submit_frame(geometry)

    if session.liveness.status is LivenessStatus.PASSED:
        _extract_probe(session)

    return _verify_response(session, face_detected=geometry is not None)


def _extract_probe(session: VerificationSession) -> None:
    """Embed the best frame of the session, once liveness has passed."""
    if session.probe_embedding is not None or session.best_frame is None:
        return

    face, reason = _single_usable_face(session.best_frame)
    if face is None:
        # Liveness proved a live person was present, but no frame in the
        # session was good enough to identify them. That is a capture-quality
        # failure, not a spoof, and the user should simply retry.
        session.liveness.status = LivenessStatus.FAILED
        session.liveness.failure_reason = f"no_matchable_frame:{reason}"
        return

    session.probe_embedding = face.embedding


def _verify_response(
    session: VerificationSession, *, face_detected: bool
) -> VerifyFrameResponse:
    outcome = session.liveness.outcome()
    return VerifyFrameResponse(
        status=outcome.status,
        prompt=outcome.prompt,
        step_index=outcome.step_index,
        total_steps=outcome.total_steps,
        step_progress=outcome.step_progress,
        failure_reason=outcome.failure_reason,
        face_detected=face_detected,
        ready_to_match=session.probe_embedding is not None,
    )


@app.post("/verify/match", response_model=MatchResponse)
def verify_match(request: MatchRequest) -> MatchResponse:
    """Identify the verified face against a candidate pool.

    Refuses to run unless liveness passed. Ordering the pipeline this way is
    what stops the service from ever spending an embedding comparison on a
    printed photo.
    """
    session = verification_sessions.get(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="unknown or expired session")

    if session.liveness.status is not LivenessStatus.PASSED:
        raise HTTPException(
            status_code=409,
            detail=f"liveness not passed (status: {session.liveness.status.value})",
        )
    if session.probe_embedding is None:
        raise HTTPException(status_code=409, detail="no probe embedding available")

    try:
        gallery = [
            recognition.GalleryEntry(
                user_id=entry.user_id,
                embedding=recognition.decode_embedding(entry.embedding_b64),
            )
            for entry in request.gallery
        ]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result = recognition.identify(
        session.probe_embedding,
        gallery,
        threshold=request.threshold,
        margin=request.margin,
    )

    # One session, one identification attempt. Without this a caller could
    # retry the same probe against different thresholds until something
    # matched, which would turn the margin rule into a formality.
    verification_sessions.discard(request.session_id)

    return MatchResponse(
        decision=result.decision,
        user_id=result.user_id,
        top_score=result.top_score,
        runner_up_score=result.runner_up_score,
        margin=result.margin,
        gallery_size=result.gallery_size,
        candidates=[
            CandidateModel(user_id=c.user_id, score=c.score) for c in result.candidates
        ],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app", host=settings.host, port=settings.port, log_level=settings.log_level
    )
