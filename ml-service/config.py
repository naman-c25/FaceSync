"""Every tunable number in the ML service lives here.

Nothing in the pipeline hardcodes a threshold. During testing you will change
these constantly, and you should be able to do it without touching logic code.

Any value can also be overridden by an environment variable prefixed with
FACEPAY_, e.g. FACEPAY_MATCH_THRESHOLD=0.72, so you can sweep thresholds from
a script without editing this file.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="FACEPAY_", env_file=".env", extra="ignore"
    )

    # ------------------------------------------------------------------
    # Face detection / frame quality
    # ------------------------------------------------------------------
    # InsightFace detector confidence. Below this the frame has no usable face.
    det_score_threshold: float = 0.60

    # A face smaller than this (as a fraction of frame height) is too far away
    # to embed reliably. Rejecting early is cheaper than matching a blurry face.
    min_face_height_ratio: float = 0.15

    # Reject frames with more than one face — at a kiosk, an extra face in view
    # is ambiguous about who is actually paying.
    max_faces_in_frame: int = 1

    # Laplacian variance below this means the frame is too blurry to trust.
    min_sharpness: float = 45.0

    # ------------------------------------------------------------------
    # Liveness — blink detection (EAR)
    # ------------------------------------------------------------------
    # Eye Aspect Ratio drops sharply during a blink. Open eyes sit around
    # 0.28-0.35; a closed eye falls under 0.20. Tune per-person if needed —
    # people with narrow eyes may need this lowered.
    ear_threshold: float = 0.21

    # A blink must span at least this many consecutive frames below threshold.
    # Guards against single-frame noise being counted as a blink.
    ear_consec_frames: int = 2

    # ...and no more than this many, otherwise the user simply has their eyes
    # closed (or it is a photo of someone with closed eyes) rather than blinking.
    ear_max_closed_frames: int = 12

    blinks_required: int = 2

    # ------------------------------------------------------------------
    # Liveness — gaze challenge
    # ------------------------------------------------------------------
    # A look step is scored on *movement away from rest*, not on absolute
    # position. That distinction is a security property, not a refinement:
    # people hold their head at all sorts of resting angles, so any absolute
    # threshold loose enough to accept them is also satisfied by a still photo
    # of someone whose head happens to be turned that way. A photo cannot
    # change its pose mid-challenge; a live person can.
    #
    # Both are measured against a baseline captured at the start of each step.

    # How far the iris must travel along the eye, as a fraction of eye width.
    gaze_delta: float = 0.08

    # How far the head must turn. Smaller than the gaze delta because the yaw
    # ratio compresses — the nose stays between the face edges however far the
    # head turns, so its full range is narrower than the iris's.
    yaw_delta: float = 0.05

    # Frames averaged at the start of a step to establish that rest position.
    # Averaging rather than taking one frame keeps landmark jitter out of the
    # baseline, which would otherwise offset every comparison that follows.
    baseline_frames: int = 3

    # Set true only if the frontend sends a horizontally flipped frame.
    # getUserMedia delivers an unmirrored frame and a CSS scaleX(-1) preview
    # mirrors the *display* only, so the default is correct for the usual
    # setup. If "look left" starts failing while "look right" passes, this is
    # the single switch to flip — do not go rewriting the gaze comparisons.
    frames_are_mirrored: bool = False

    # How many frames must satisfy the gaze direction before it counts as held.
    # A replayed video will rarely hit the randomly-chosen direction on cue.
    gaze_hold_frames: int = 3

    # ------------------------------------------------------------------
    # Liveness — session limits
    # ------------------------------------------------------------------
    # A live person completes a challenge in a few seconds. A long session
    # usually means someone is fiddling with a spoof.
    liveness_timeout_seconds: float = 12.0
    liveness_max_frames: int = 150

    # Faces drop out for a frame or two constantly — a hand passes the lens, the
    # user glances away. Only a sustained run means they actually left.
    max_consecutive_missing_face: int = 15

    # How many actions the randomised challenge asks for. Two keeps it under
    # about five seconds while making the exact sequence hard to pre-record.
    challenge_steps: int = 2

    # How long an idle session survives in the store before being evicted.
    session_ttl_seconds: float = 300.0

    # ------------------------------------------------------------------
    # Recognition / 1:N matching
    # ------------------------------------------------------------------
    # Cosine similarity above which two embeddings are considered the same
    # person. Calibrate this from your own genuine-vs-impostor score
    # distributions — do not ship the default blindly.
    match_threshold: float = 0.45

    # 1:N safety rail. The best match must beat the runner-up by this margin.
    # If the top two candidates are near-tied the system does not actually know
    # who this is, and picking the higher score would be a coin flip.
    match_margin: float = 0.08

    # InsightFace model pack. buffalo_l = SCRFD detector + ArcFace w600k (512-d).
    insightface_model: str = "buffalo_l"
    insightface_root: str = str(BASE_DIR / "models")

    # Detector working resolution. Larger catches smaller faces but is slower.
    det_size: int = 640

    # ------------------------------------------------------------------
    # Enrollment
    # ------------------------------------------------------------------
    min_enrollment_samples: int = 5
    max_enrollment_samples: int = 8

    # Enrollment samples should be the same person at different angles. If a
    # sample sits this far from the running mean, it is probably a different
    # person (or a badly corrupted frame) and is rejected.
    enrollment_consistency_threshold: float = 0.40

    # ------------------------------------------------------------------
    # Preprocessing
    # ------------------------------------------------------------------
    # CLAHE (contrast-limited adaptive histogram equalisation) normalises
    # lighting so a dim frame and a bright frame stay comparable.
    clahe_clip_limit: float = 2.0
    clahe_tile_grid_size: int = 8

    # ------------------------------------------------------------------
    # Service
    # ------------------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8001
    log_level: str = "info"


settings = Settings()
