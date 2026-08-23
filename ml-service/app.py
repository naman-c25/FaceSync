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
import pad
import preprocessing
import recognition
from config import settings
from liveness import LivenessSession, LivenessStatus
from schemas import (
    CandidateModel,
    CapturedFrame,
    CompareRequest,
    CompareResponse,
    EnrollmentCaptureResponse,
    EnrollmentFinalizeRequest,
    EnrollmentFinalizeResponse,
    EnrollmentStartResponse,
    FrameBatchRequest,
    FrameRequest,
    HealthResponse,
    LivenessSignalsModel,
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
        await loop.run_in_executor(None, pad.warm_up)
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


def _prepare_frame(
    request: FrameRequest,
) -> tuple[np.ndarray | None, preprocessing.FrameQuality]:
    """Decode and condition one frame, without judging whether to keep it.

    Only genuinely undecodable bytes fail here. Whether a frame is *good
    enough* depends on what it is for, and the two callers disagree — so that
    decision belongs to them, not to this function.

    Both go through here so a face is preprocessed identically at both ends.
    CLAHE applied during enrollment but not verification would shift the
    embeddings apart and quietly wreck every similarity score.
    """
    image = preprocessing.decode_image(request.image_bytes)
    if image is None:
        return None, preprocessing.FrameQuality(False, 0.0, 0.0, "undecodable_image")

    quality = preprocessing.assess_frame(image)
    return preprocessing.normalize_lighting(image), quality


def _single_usable_face(
    frame: np.ndarray,
) -> tuple[recognition.DetectedFace | None, str | None]:
    """Detect exactly one face, large and confident enough to trust."""
    faces = recognition.detect_faces(frame)

    if not faces:
        return None, "no_face_detected"

    # With more than one face in view, the largest is taken only when it is
    # unmistakably the subject. Distance does the work: the person at the till
    # is half a metre from the lens and anyone behind them is two or three, and
    # apparent size falls with the square of that.
    #
    # Below the ratio this refuses, and that refusal is the point. Two faces of
    # comparable size means the system genuinely cannot tell which of them is
    # paying, and picking the bigger one would be a coin flip charged to
    # somebody's account.
    faces = sorted(faces, key=lambda f: f.bbox_area, reverse=True)

    if len(faces) > settings.max_faces_in_frame:
        runner_up = faces[settings.max_faces_in_frame].bbox_area
        dominance = faces[0].bbox_area / runner_up if runner_up > 0 else float("inf")
        if dominance < settings.face_dominance_ratio:
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

    # Enrollment applies the quality gate strictly. The user is standing right
    # there, so asking for another frame costs a second — whereas a soft sample
    # averaged into the stored identity degrades every future match.
    frame, quality = _prepare_frame(request)
    if frame is None or not quality.acceptable:
        session.rejected_frames += 1
        return EnrollmentCaptureResponse(
            accepted=False,
            samples_collected=len(session.samples),
            samples_required=settings.min_enrollment_samples,
            reason=quality.reason,
            sharpness=round(quality.sharpness, 2),
        )

    face, reason = _single_usable_face(frame)
    if face is None:
        session.rejected_frames += 1
        return EnrollmentCaptureResponse(
            accepted=False,
            samples_collected=len(session.samples),
            samples_required=settings.min_enrollment_samples,
            reason=reason,
            sharpness=round(quality.sharpness, 2),
        )

    session.samples.append(face.embedding)
    return EnrollmentCaptureResponse(
        accepted=True,
        samples_collected=len(session.samples),
        samples_required=settings.min_enrollment_samples,
        sharpness=round(quality.sharpness, 2),
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


@app.post("/compare", response_model=CompareResponse)
def compare(request: CompareRequest) -> CompareResponse:
    """Match one embedding against a gallery, outside any session.

    Enrollment uses this to ask whether the person registering is already on
    file. Left unchecked, a second registration of the same face lands a
    near-identical twin in the gallery — and from then on that person can never
    be identified, because the two copies sit within the margin of each other
    and every attempt comes back ambiguous. One re-enrollment quietly locks
    someone out for good.

    This deliberately does not go through /verify/match, which refuses to run
    without a passed liveness challenge. That refusal is the guarantee that no
    spoofed frame is ever matched, and it should not be weakened to accommodate
    a different question.
    """
    try:
        probe = recognition.decode_embedding(request.embedding_b64)
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
        probe, gallery, threshold=request.threshold, margin=request.margin
    )

    return CompareResponse(
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
def verify_frame(request: FrameBatchRequest) -> VerifyFrameResponse:
    """Feed a batch of consecutive frames into the liveness challenge.

    Only MediaPipe runs per frame. The far more expensive ArcFace pass happens
    once, after liveness has passed — which is the whole point of checking
    liveness first.

    Frames arrive in batches rather than one per request because the sampling
    rate has to be decoupled from the round trip. A browser captures at 15fps
    and can ship maybe 4fps over a tunnel; at 4fps a 250ms blink lands between
    two samples more often than not, which is why gaze challenges were passing
    while blink challenges failed on the same connection.

    Each frame carries the moment it was taken, and the state machine is driven
    by those rather than by arrival — timing a batch by when it landed would
    collapse it to a single instant and leave every blink unmeasurable.
    """
    session = verification_sessions.get(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="unknown or expired session")

    if session.liveness.status is not LivenessStatus.IN_PROGRESS:
        return _verify_response(session, face_detected=False)

    face_detected = False
    for frame_request in request.frames:
        face_detected = _consume_frame(session, frame_request)
        if session.liveness.status is not LivenessStatus.IN_PROGRESS:
            break

    if session.liveness.status is LivenessStatus.PASSED:
        _extract_probe(session)

    return _verify_response(session, face_detected=face_detected)


def _consume_frame(session: VerificationSession, request: CapturedFrame) -> bool:
    """Run one frame through detection and the state machine.

    Returns whether a face was found, which the caller reports for the most
    recent frame so the kiosk can tell someone they have moved out of shot.
    """

    # No quality gate here, deliberately. The sharpness threshold exists to
    # protect embedding quality, and liveness does not need a sharp frame —
    # MediaPipe finds landmarks in a moderately blurred one perfectly well.
    #
    # Applying it here was a false-rejection bug. Following a "look right"
    # prompt motion-blurs the frames during the turn; every one was discarded
    # before detection ran, and the state machine read that run of discarded
    # frames as the face having left. A user doing exactly what the prompt
    # asked failed the challenge with `face_lost`.
    #
    # A frame too soft to embed still cannot become the probe: sharpness feeds
    # the best-frame score, and _extract_probe checks it again.
    frame, quality = _prepare_frame(request)
    usable = frame is not None and quality.sharpness >= settings.min_sharpness_liveness
    geometry = face_detection.analyse(frame) if usable else None

    # The same dominance rule the embedding path applies, applied here too.
    # Without it liveness would happily read the mesh of whoever the model
    # ranked first while the payment charged the face the detector picked --
    # so a bystander's blinks could satisfy a challenge for the person in
    # front of them. Both stages choose the largest face, which is what keeps
    # them on the same person.
    if geometry is not None and geometry.dominance < settings.face_dominance_ratio:
        session.liveness.signals.frames_crowded += 1
        geometry = None

    if usable and geometry is not None:
        session.offer_frame(
            frame,
            frame_quality_score(geometry, quality.sharpness),
            sharpness=quality.sharpness,
        )

    # Driven by when the frame was captured, not when it arrived.
    session.liveness.submit_frame(geometry, now=request.captured_at_ms / 1000.0)
    return geometry is not None


def _extract_probe(session: VerificationSession) -> None:
    """Embed the best frame of the session, once liveness has passed."""
    if session.probe_embedding is not None or session.best_frame is None:
        return

    # The gate liveness skipped, applied to the one frame that matters. If the
    # whole session was blurred, the sharpest frame in it is still too soft to
    # embed, and matching against it would produce a score that means nothing.
    if session.best_frame_sharpness < settings.min_sharpness:
        session.liveness.status = LivenessStatus.FAILED
        session.liveness.failure_reason = "no_matchable_frame:frame_too_blurry"
        return

    face, reason = _single_usable_face(session.best_frame)
    if face is None:
        # Liveness proved a live person was present, but no frame in the
        # session was good enough to identify them. That is a capture-quality
        # failure, not a spoof, and the user should simply retry.
        session.liveness.status = LivenessStatus.FAILED
        session.liveness.failure_reason = f"no_matchable_frame:{reason}"
        return

    # Presentation attack detection, on the one frame that decides identity.
    # Here rather than per-frame because it is the frame the payment will rest
    # on, and running it fifty times a session would cost fifty times as much
    # to answer the same question.
    verdict = pad.assess(session.best_frame, face.bbox)
    session.spoof = verdict

    # `available` is False when the models could not be given the crop they
    # were trained on -- see pad.py. That is not a pass and not a fail, and
    # treating it as either would be inventing a verdict.
    if verdict.is_attack and settings.pad_enforce:
        session.liveness.status = LivenessStatus.FAILED
        session.liveness.failure_reason = f"presentation_attack:{verdict.label_text}"
        return

    session.probe_embedding = face.embedding


def _signals(session: VerificationSession) -> LivenessSignalsModel:
    liveness = session.liveness
    verdict = session.spoof

    return LivenessSignalsModel(
        **vars(liveness.signals),
        challenge=[step.prompt for step in liveness.challenge],
        # Reported whether or not it changed the outcome. A recorded near-miss
        # is what makes the threshold tunable later; an unrecorded one is
        # invisible until it matters.
        spoof_available=bool(verdict and verdict.available),
        spoof_real_score=verdict.real_score if verdict and verdict.available else None,
        spoof_label=verdict.label_text if verdict else None,
        spoof_models_used=verdict.models_used if verdict else 0,
        spoof_crop_scale=verdict.crop_scale if verdict else None,
    )


def _verify_response(
    session: VerificationSession, *, face_detected: bool
) -> VerifyFrameResponse:
    outcome = session.liveness.outcome()
    settled = outcome.status is not LivenessStatus.IN_PROGRESS

    return VerifyFrameResponse(
        status=outcome.status,
        prompt=outcome.prompt,
        step_index=outcome.step_index,
        total_steps=outcome.total_steps,
        step_progress=outcome.step_progress,
        failure_reason=outcome.failure_reason,
        face_detected=face_detected,
        ready_to_match=session.probe_embedding is not None,
        # Only once there is a verdict — see LivenessSignalsModel.
        signals=_signals(session) if settled else None,
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

    # Held before the session is discarded below, since the response returns it.
    probe = session.probe_embedding

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
        probe, gallery, threshold=request.threshold, margin=request.margin
    )

    # Captured before the session is discarded, since the log needs it.
    signals = _signals(session)

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
        probe_embedding_b64=recognition.encode_embedding(probe),
        signals=signals,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app", host=settings.host, port=settings.port, log_level=settings.log_level
    )
