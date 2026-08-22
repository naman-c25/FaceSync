"""In-memory session state for multi-frame enrollment and verification flows.

Both flows span many frames, so something has to remember what happened between
requests. In production this belongs in Redis — shared across service instances
and surviving a restart. For a single-instance demo a guarded dict is the same
thing without the operational overhead, and `SessionStore` is a narrow enough
interface that swapping the backing store later touches only this file.
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Generic, TypeVar

import numpy as np

from config import settings
from face_detection import FaceGeometry
from liveness import LivenessSession


@dataclass
class EnrollmentSession:
    """Accumulates the samples that will be fused into one stored identity."""

    session_id: str
    created_at: float = field(default_factory=time.monotonic)
    last_seen_at: float = field(default_factory=time.monotonic)
    samples: list[np.ndarray] = field(default_factory=list)
    rejected_frames: int = 0

    def is_expired(self) -> bool:
        return time.monotonic() - self.last_seen_at > settings.session_ttl_seconds


@dataclass
class VerificationSession:
    """One liveness challenge plus the frame that will be matched afterwards.

    `best_frame` is the point of this class. Liveness finishes on whichever
    frame happens to complete the last action — which is very likely a frame
    where the user is mid-blink or looking hard to one side, since that is what
    the challenge just asked for. Embedding that frame would be the worst
    possible choice. Instead every frame is scored as it arrives and the
    strongest one is kept back for recognition.
    """

    session_id: str
    liveness: LivenessSession
    created_at: float = field(default_factory=time.monotonic)
    last_seen_at: float = field(default_factory=time.monotonic)
    best_frame: np.ndarray | None = None
    best_frame_score: float = 0.0
    best_frame_sharpness: float = 0.0
    probe_embedding: np.ndarray | None = None

    def is_expired(self) -> bool:
        return time.monotonic() - self.last_seen_at > settings.session_ttl_seconds

    def offer_frame(self, frame: np.ndarray, score: float, *, sharpness: float) -> bool:
        """Keep this frame if it beats the best one seen so far.

        Sharpness is carried alongside the composite score so the winner can be
        checked against the embedding threshold later. Liveness accepts frames
        far softer than recognition should, and without this the sharpest of a
        uniformly blurred session would still be embedded.
        """
        if score <= self.best_frame_score:
            return False
        self.best_frame = frame.copy()
        self.best_frame_score = score
        self.best_frame_sharpness = sharpness
        return True


def frame_quality_score(geometry: FaceGeometry, sharpness: float) -> float:
    """Rank a frame's suitability for embedding — higher is better.

    Sharpness sets the scale, then three penalties scale it down:

    - A closed eye scores zero outright, however sharp the frame is. The test
      is skipped on frames where the head is too turned for EAR to mean
      anything, since there a low value describes the angle, not the eyelid.
    - A turned head is penalised, because ArcFace was trained mostly on faces
      looking at the camera and a profile pushes the embedding away from the
      enrolled average.
    - Gaze away from centre is penalised the same way and for the same reason.
    """
    if geometry.ear_is_meaningful and geometry.ear < settings.ear_threshold:
        return 0.0

    gaze_centrality = max(0.0, 1.0 - 2.0 * abs(geometry.gaze_horizontal - 0.5))
    return sharpness * geometry.frontality * gaze_centrality


SessionT = TypeVar("SessionT", EnrollmentSession, VerificationSession)


class SessionStore(Generic[SessionT]):
    """A TTL dict, guarded for concurrent access."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionT] = {}
        self._lock = threading.Lock()

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex

    def put(self, session: SessionT) -> SessionT:
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> SessionT | None:
        """Fetch a live session, refreshing its TTL.

        An expired session is dropped rather than returned, so a caller that
        went away for ten minutes gets a clean "unknown session" instead of
        resuming a challenge whose timing guarantees no longer hold.
        """
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            if session.is_expired():
                del self._sessions[session_id]
                return None
            session.last_seen_at = time.monotonic()
            return session

    def discard(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def purge_expired(self) -> int:
        """Drop timed-out sessions. Without this the dict grows forever."""
        with self._lock:
            stale = [
                sid for sid, session in self._sessions.items() if session.is_expired()
            ]
            for sid in stale:
                del self._sessions[sid]
            return len(stale)

    def __len__(self) -> int:
        with self._lock:
            return len(self._sessions)


enrollment_sessions: SessionStore[EnrollmentSession] = SessionStore()
verification_sessions: SessionStore[VerificationSession] = SessionStore()
