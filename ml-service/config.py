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

    # An extra face in view is ambiguous about who is actually paying, and a
    # kiosk must never guess. Rejecting outright is the safe answer and was the
    # original one — but in a busy shop there is nearly always somebody in the
    # background, and a terminal that refuses every frame is not a terminal.
    #
    # So one face may be accepted alongside others, but only when it is
    # unmistakably the subject: at least this many times the area of the next
    # largest. Distance does the work. Someone at the till is roughly half a
    # metre from the lens and someone browsing behind them is two or three, and
    # apparent size falls with the square of that — so the person paying is
    # comfortably four to thirty times larger in frame. Three is well inside
    # that and well outside anything two people standing together produce.
    #
    # Below the ratio the frame is refused, which is the whole point: two faces
    # of comparable size means the system genuinely cannot tell which of them is
    # paying, and picking the bigger one would be a coin flip charged to
    # somebody's account.
    max_faces_in_frame: int = 1
    face_dominance_ratio: float = 3.0

    # How many faces the landmark model is allowed to return so the rule above
    # can be applied to it as well. Both stages have to agree on *which* face is
    # the subject: liveness reads the mesh and the embedding comes from the
    # detector, and if those two ever picked different people the challenge
    # would be measuring one person while the payment charged another.
    face_candidates: int = 3

    # Share of a scan's frames that may hold two comparable faces before the
    # whole scan is refused.
    #
    # The dominance rule decides *within* a frame, and it is right to: someone
    # at the till with a browser behind them should be served. But a scan where
    # a third of the frames held two faces is a different situation -- someone
    # is holding something up, or two people are leaning in -- and quietly
    # resolving that to whoever happened to be largest is how a payment gets
    # attributed to the wrong person with nothing on screen to say so.
    #
    # Found by holding a photograph of somebody else up to the camera: the
    # holder's own face was larger, so it won every frame it appeared in, and
    # the till confidently named the holder. Correct by the rule, and useless
    # to anyone watching.
    max_crowded_frame_ratio: float = 0.25

    # Laplacian variance below this means the frame is too blurry to embed.
    # Applies to enrollment samples and to the frame finally matched against.
    min_sharpness: float = 45.0

    # A much lower floor for liveness, because the two need different things.
    # MediaPipe finds landmarks far below the embedding threshold — measured on
    # one face: sharpness 51.8 gave EAR 0.257 and sharpness 10.1 gave 0.219,
    # against 0.271 unblurred. Below roughly 8 the geometry becomes noise
    # (sharpness 4.4 read EAR 0.163 on the same face).
    #
    # Using the embedding threshold here was a false-rejection bug: turning to
    # follow a "look right" prompt motion-blurs the frames mid-turn, all of
    # them were discarded before detection, and a run of discarded frames read
    # as the face having left.
    min_sharpness_liveness: float = 8.0

    # ------------------------------------------------------------------
    # Liveness — blink detection (EAR)
    # ------------------------------------------------------------------
    # A blink is scored against a fraction of *this person's* own open-eye EAR,
    # not a fixed number. Measured across five people, open-eye EAR ranged from
    # 0.316 to 0.418 — a 32% spread, wide enough that one global threshold is
    # either too high for narrow eyes or too low for wide ones.
    #
    # What held steady was the ratio: every blink floor landed at 16-22% of
    # that same person's open value (0.086/0.418, 0.051/0.316, 0.067/0.408,
    # 0.074/0.342, 0.053/0.326). So 0.55 sits comfortably below every open eye
    # and far above every blink floor, for all of them.
    ear_closed_fraction: float = 0.55

    # Frames used to measure the open-eye value at the start of a blink step.
    # The *maximum* over the window is taken, not the mean: a blink during the
    # window would drag a mean down and quietly raise the bar for every blink
    # after it, while the max still reports the open eye.
    ear_baseline_frames: int = 8

    # Fallback for before a baseline exists. Set from the same five sessions:
    # above every blink floor seen (max 0.086) and below every open eye (min
    # 0.316), sitting roughly midway.
    ear_threshold: float = 0.20

    # EAR divides eyelid height by the eye's corner-to-corner width, and that
    # width foreshortens as the head turns while the height barely does. Near
    # profile the denominator collapses and EAR explodes — values above 1.0 are
    # routine at extreme angles and mean nothing about whether the eye is open.
    #
    # So blinks are only counted while the face is roughly square to the
    # camera. `frontality` is 1.0 head-on and 0.0 at full profile; 0.75 allows
    # a normal amount of head movement while keeping EAR meaningful.
    min_frontality_for_blink: float = 0.75

    # Anything outside this band is not a measurement of an eye, whatever the
    # geometry says — a hard backstop for frames the frontality gate misses.
    ear_plausible_range: tuple[float, float] = (0.05, 0.60)

    # A blink is a duration, not a number of frames, and the two only agree at
    # a fixed frame rate. A browser streaming frames to a server runs at
    # whatever the round trip allows — often 5-8fps against 30 locally — and a
    # frame-counted threshold that works on a laptop misses every blink over a
    # network, because a 150ms closure spans fewer than two frames there.
    #
    # Measuring the closure in milliseconds holds at any rate: at 30fps a real
    # blink covers several frames and still measures ~150ms, while a
    # single-frame dip measures ~33ms and is correctly read as noise.
    blink_min_ms: float = 60.0

    # Beyond this the eyes are being held shut rather than blinked — or it is a
    # photo of someone with their eyes closed.
    blink_max_ms: float = 700.0

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

    # Both are sized from the weakest direction any of five test subjects could
    # reach, not from their best. People turn much further one way than the
    # other — one subject moved -0.395 but only +0.090 in yaw — and a threshold
    # built from the strong side is unreachable on the weak one.
    #
    # Weakest reachable across those subjects: gaze 0.071, yaw 0.090. These sit
    # at roughly 70% of that, and a step passes on gaze *or* yaw, so a subject
    # only has to clear one of them.

    # How far the iris must travel along the eye, as a fraction of eye width.
    gaze_delta: float = 0.05

    # How far the head must turn.
    yaw_delta: float = 0.06

    # Below this much head movement the head counts as still, and the gaze
    # ratio is read as a deliberate eye movement. Above it, only the yaw is
    # trusted.
    #
    # This exists because the two signals are not independent, which a live
    # kiosk found the hard way: prompted one way and turning the other, the
    # challenge passed anyway. The prompt is on the screen, so people read it,
    # turn their head, and keep their eyes on the camera — and eyeballs that
    # stay on target while the head rotates counter-rotate in their sockets.
    # In the mesh that drives the iris toward the opposite eye corner, so gaze
    # and yaw come out of one movement with *opposite* signs, and a rule that
    # accepted either one independently was satisfied by whichever happened to
    # point at the requested direction.
    #
    # Set to half of yaw_delta from the logged ranges: real turns move yaw by
    # 0.28-0.62 and gaze by comparable amounts, so counter-rotation scales
    # roughly one-to-one with the turn. At half the yaw a turn needs to count,
    # the induced gaze shift lands near 0.03 — below gaze_delta, so it cannot
    # carry a step on its own.
    yaw_still_max: float = 0.03

    # Frames averaged at the start of a step to establish that rest position.
    # Averaging rather than taking one frame keeps landmark jitter out of the
    # baseline, which would otherwise offset every comparison that follows.
    baseline_frames: int = 5

    # ...and they must be *still* frames. This is the important half, and
    # leaving it out was a live bug: prompted one way, moving the other way
    # passed anyway.
    #
    # Three frames at 15fps is 200ms, and the moment a look step begins is
    # exactly when the head is least likely to be at rest — the previous step
    # just turned it, and it is on its way back. A baseline averaged over a
    # head in motion records a "rest" position that the head was merely passing
    # through, and the rest of the return to centre then reads as deliberate
    # movement. Whichever way the head happened to be travelling satisfied the
    # next prompt, with no help from the person at all.
    #
    # So the window has to settle before it counts. If the head is moving, the
    # oldest sample is dropped and another taken, until a whole window sits
    # inside this spread. The step timeout handles someone who never holds
    # still.
    #
    # Sized well under yaw_delta so a baseline can never be locked mid-turn:
    # a genuine turn moves yaw by 0.28-0.62, hundreds of times this.
    baseline_stillness: float = 0.02

    # Set true only if the frontend sends a horizontally flipped frame.
    # getUserMedia delivers an unmirrored frame and a CSS scaleX(-1) preview
    # mirrors the *display* only, so the default is correct for the usual
    # setup. If "look left" starts failing while "look right" passes, this is
    # the single switch to flip — do not go rewriting the gaze comparisons.
    frames_are_mirrored: bool = False

    # How long the direction must be held before it counts. Time-based for the
    # same reason as the blink window — a frame count means different things on
    # a laptop and over a network.
    gaze_hold_ms: float = 250.0

    # ------------------------------------------------------------------
    # Liveness — session limits
    # ------------------------------------------------------------------
    # A live person completes a challenge in a few seconds. A long session
    # usually means someone is fiddling with a spoof.
    # Long enough to read two prompts and perform them. 12s was too tight over
    # a network: people were still working through the challenge when it
    # expired, then closed the tab.
    liveness_timeout_seconds: float = 25.0

    # A backstop on compute, not a stand-in for the timeout. It used to be 150,
    # which at a local 30fps is five seconds — so the frame budget, not the
    # timeout, was ending challenges, and it ended them well before anyone
    # could blink twice and then turn their head. Set high enough that the
    # timeout always governs at any plausible capture rate.
    liveness_max_frames: int = 700

    # Faces drop out for a frame or two constantly — a hand passes the lens, the
    # user glances away. Only a sustained run means they actually left.
    max_consecutive_missing_face: int = 15

    # Which liveness mode a verification runs.
    #
    #   "challenge"  the randomised blink/look prompt
    #   "passive"    hold still, no prompt, no instruction
    #
    # Switched rather than deleted, so the challenge, its tests and its
    # measurements all stay in the tree and one environment variable puts it
    # back: FACEPAY_LIVENESS_MODE=challenge.
    #
    # Passive is the faster flow and it is the weaker one, and the difference
    # is not subtle. Measured on this pipeline, a still photograph passes every
    # per-frame gate there is -- sharpness 51.9 against a floor of 45,
    # detection score 0.865 against 0.60, landmarks found, a usable 512-d
    # embedding. Nothing outside the challenge objects to a photograph. So in
    # passive mode the face stops being a factor an attacker has to defeat and
    # the PIN is doing the work on its own.
    #
    # What passive mode does check is written down honestly in
    # `_advance_passive`: enough frames, one dominant face, over a minimum
    # duration, and frames that are not identical. That catches a static image
    # fed straight into the pipeline. It does not catch a photograph held up to
    # the camera, and it must not be described as though it does.
    liveness_mode: str = "passive"

    # How long a passive scan must watch a face before it will accept one.
    # Short enough not to feel like a wait, long enough that the frames are a
    # sample of someone standing there rather than one instant.
    passive_scan_seconds: float = 1.6
    passive_min_frames: int = 12

    # How many actions the randomised challenge asks for.
    #
    # Two was meant to keep this under about five seconds. Measured against 86
    # real attempts it did not: the median successful challenge took 8.0s, the
    # 90th percentile 18.4s, and one attempt in five failed outright. That is
    # not a checkout — that is a queue.
    #
    # One step roughly halves it, and what it costs is worth being precise
    # about. A printed photo still fails every action, so the attack this
    # mostly exists to stop is stopped either way. What weakens is replay: a
    # recording containing a blink and both head turns can satisfy whichever
    # single action is asked, where two steps also had to match the order
    # within the timeout.
    #
    # That residual case needs the attacker to hold a video of the customer
    # *and* their PIN, since a payment cannot complete without both. Against a
    # one-in-five failure rate on genuine customers, that is the better trade
    # here. It would not be at enrollment, which has no challenge at all today
    # and is where a face gets bound to an account.
    challenge_steps: int = 1

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

    # ------------------------------------------------------------------
    # Presentation attack detection
    # ------------------------------------------------------------------
    # Two MiniFASNets from minivision-ai/Silent-Face-Anti-Spoofing, judging
    # pixels rather than geometry -- ink on paper, a display's pixel grid,
    # light scattered under real skin. See pad.py for why the two hand-built
    # geometric checks were measured and abandoned before reaching for this.
    pad_enabled: bool = True

    # Below this real-class score the face is treated as a presentation attack.
    #
    # A threshold rather than argmax, which is what the reference uses and is
    # the weaker reading: on the project's own samples a held printout scores
    # 0.728 real, which argmax calls real and a threshold catches. Genuine
    # faces in those samples score 0.999 and 1.000, so there is a wide gap to
    # sit in.
    #
    # Still not calibrated on the camera this runs on -- this is a reading of
    # eight attempts from one, not a measurement. There, three screen replays
    # scored 0.006, 0.110 and 0.225 while everything the models called real
    # scored 0.572 and above, so the gap sits between 0.23 and 0.57 and 0.70
    # is inside it with room either side.
    #
    # It went up from 0.55 because one attempt at 0.572 got through, and the
    # things that were clearly blocked stayed far below. The cost of being
    # wrong is not symmetric -- a false rejection is a customer asked to try
    # again, a false acceptance is a photograph taking money -- which is the
    # argument for the higher of two defensible numbers rather than the lower.
    #
    # Settle it properly with tools/collect_pad.py and tools/silent_pad.py
    # --data, which give a labelled table instead of a reading.
    pad_threshold: float = 0.70

    # Whether a verdict actually stops a payment, or is only recorded.
    #
    # Enforcement is on because a photograph reaching the embedding stage is
    # the whole problem this exists to solve. Every attempt is logged either
    # way, so turning this off leaves a full record to tune against without
    # refusing anyone.
    pad_enforce: bool = True

    # How far the crop may fall short of what the models were trained on before
    # their answer stops being worth having.
    #
    # Clamping is normal rather than an edge case: the reference project's own
    # sample images all clamp, landing between 1.90 and 2.62, and the models
    # classify them correctly there. What is not normal is clamping far down --
    # the one reference sample they get wrong, a printout held close to the
    # lens, is also the only one whose crop collapses to 1.21.
    #
    # So this sits between the two. Below it there is no verdict rather than a
    # bad one, and the achieved scale is recorded on every attempt so the floor
    # can be moved once a real camera has produced numbers.
    pad_min_crop_scale: float = 1.5

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
