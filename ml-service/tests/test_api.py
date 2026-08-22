"""End-to-end API tests against the real models.

These are slower than the unit tests because they load InsightFace and
MediaPipe for real. Frames come from the group photo that ships with
InsightFace, cropped to one face per frame, which gives genuine faces without
committing anyone's biometric data to the repository.

The full verification path cannot be exercised here — liveness needs a moving
subject, and no still image blinks. What is covered is the API contract, the
frame-rejection rules, and the enrollment fusion path end to end. Liveness
logic is covered exhaustively in test_liveness.py against synthetic geometry.
"""

import base64
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app import app
from config import settings

pytestmark = pytest.mark.slow


def _sample_photo() -> np.ndarray:
    import insightface

    path = Path(insightface.__file__).parent / "data" / "images" / "t1.jpg"
    image = cv2.imread(str(path))
    if image is None:
        pytest.skip(f"InsightFace sample photo not found at {path}")
    return image


def _to_b64(image: np.ndarray) -> str:
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert ok, "failed to encode test frame"
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def _crop_face(image: np.ndarray, bbox, margin: float = 0.7) -> np.ndarray:
    """Cut one face out with enough surrounding context to still be detectable.

    A tight crop is not enough: SCRFD is trained on faces in scenes and does
    poorly on a bare aligned face, so the margin here is deliberately generous.
    """
    x1, y1, x2, y2 = bbox
    pad_x, pad_y = int((x2 - x1) * margin), int((y2 - y1) * margin)

    height, width = image.shape[:2]
    return image[
        max(y1 - pad_y, 0) : min(y2 + pad_y, height),
        max(x1 - pad_x, 0) : min(x2 + pad_x, width),
    ]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def faces():
    """Two different people, cropped from the group photo."""
    import recognition

    photo = _sample_photo()
    detected = recognition.detect_faces(photo)
    if len(detected) < 2:
        pytest.skip("needed at least two detectable faces in the sample photo")

    crops = [_crop_face(photo, face.bbox) for face in detected[:2]]
    usable = [c for c in crops if recognition.detect_faces(c)]
    if len(usable) < 2:
        pytest.skip("cropped faces were not re-detectable")

    return usable


def _vary(image: np.ndarray, index: int) -> np.ndarray:
    """Nudge brightness and scale so samples are not byte-identical.

    Real enrollment captures a moving person under changing light. Feeding the
    same bytes five times would make the fusion step look better than it is.
    """
    scale = 1.0 + 0.04 * (index % 3)
    resized = cv2.resize(image, None, fx=scale, fy=scale)
    return cv2.convertScaleAbs(resized, alpha=1.0 + 0.05 * (index % 4 - 1.5), beta=0)


# -- health ------------------------------------------------------------


def test_health_reports_loaded_models(client):
    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert body["models_loaded"] is True


# -- enrollment --------------------------------------------------------


def test_enrollment_completes_and_returns_a_unit_embedding(client, faces):
    import recognition

    session_id = client.post("/enroll/start").json()["session_id"]

    accepted = 0
    for i in range(settings.min_enrollment_samples + 2):
        body = client.post(
            "/enroll/capture",
            json={"session_id": session_id, "image_b64": _to_b64(_vary(faces[0], i))},
        ).json()
        accepted += body["accepted"]
        if accepted >= settings.min_enrollment_samples:
            break

    assert accepted >= settings.min_enrollment_samples, "no sample was accepted"

    result = client.post("/enroll/finalize", json={"session_id": session_id}).json()
    embedding = recognition.decode_embedding(result["embedding_b64"])

    assert embedding.shape == (recognition.EMBEDDING_DIM,)
    assert np.linalg.norm(embedding) == pytest.approx(1.0, abs=1e-5)
    assert result["mean_similarity"] > 0.9, "samples of one person should agree closely"


def test_finalizing_too_early_is_rejected(client, faces):
    session_id = client.post("/enroll/start").json()["session_id"]
    client.post(
        "/enroll/capture",
        json={"session_id": session_id, "image_b64": _to_b64(faces[0])},
    )

    response = client.post("/enroll/finalize", json={"session_id": session_id})
    assert response.status_code == 400


def test_a_frame_with_several_faces_is_rejected(client):
    """At a kiosk, an extra face in view makes it unclear who is enrolling."""
    session_id = client.post("/enroll/start").json()["session_id"]

    body = client.post(
        "/enroll/capture",
        json={"session_id": session_id, "image_b64": _to_b64(_sample_photo())},
    ).json()

    assert body["accepted"] is False
    assert body["reason"] == "multiple_faces_detected"


def test_a_frame_with_no_face_is_rejected(client):
    session_id = client.post("/enroll/start").json()["session_id"]
    noise = np.random.default_rng(7).integers(0, 255, (480, 640, 3), dtype=np.uint8)

    body = client.post(
        "/enroll/capture",
        json={"session_id": session_id, "image_b64": _to_b64(noise)},
    ).json()

    assert body["accepted"] is False
    assert body["reason"] in {"no_face_detected", "face_too_small"}


def test_a_blurred_frame_is_rejected_before_detection(client, faces):
    session_id = client.post("/enroll/start").json()["session_id"]
    blurred = cv2.GaussianBlur(faces[0], (31, 31), 0)

    body = client.post(
        "/enroll/capture",
        json={"session_id": session_id, "image_b64": _to_b64(blurred)},
    ).json()

    assert body["accepted"] is False
    assert body["reason"] == "frame_too_blurry"


def test_enrollment_rejects_an_unknown_session(client, faces):
    response = client.post(
        "/enroll/capture",
        json={"session_id": "does-not-exist", "image_b64": _to_b64(faces[0])},
    )
    assert response.status_code == 404


def test_malformed_base64_is_rejected(client):
    response = client.post(
        "/enroll/capture", json={"session_id": "any", "image_b64": "not base64 at all!"}
    )
    assert response.status_code == 422


# -- verification ------------------------------------------------------


def test_verification_starts_with_a_prompt(client):
    body = client.post("/verify/start").json()

    assert body["prompt"], "the user must be told what to do"
    assert body["total_steps"] == settings.challenge_steps


def test_two_sessions_get_independent_challenges(client):
    first = client.post("/verify/start").json()
    second = client.post("/verify/start").json()

    assert first["session_id"] != second["session_id"]


def test_matching_is_refused_until_liveness_passes(client):
    """The ordering guarantee: no embedding comparison on an unverified frame."""
    session_id = client.post("/verify/start").json()["session_id"]

    response = client.post(
        "/verify/match", json={"session_id": session_id, "gallery": []}
    )

    assert response.status_code == 409
    assert "liveness" in response.json()["detail"]


def test_motion_blur_does_not_read_as_the_face_leaving(client, faces):
    """The false rejection a real webcam session hit.

    Turning to follow a "look right" prompt motion-blurs the frames mid-turn.
    Those were being discarded by the embedding-quality gate before detection
    ran, and a run of discarded frames read as the face having left — so a user
    doing exactly what was asked failed with `face_lost`.

    Liveness needs landmarks, not sharpness, and MediaPipe finds them well
    below the threshold recognition requires.
    """
    session_id = client.post("/verify/start").json()["session_id"]
    blurred = _to_b64(cv2.GaussianBlur(faces[0], (9, 9), 0))

    for _ in range(settings.max_consecutive_missing_face + 5):
        body = client.post(
            "/verify/frame", json={"session_id": session_id, "image_b64": blurred}
        ).json()

    assert body["failure_reason"] != "face_lost"
    assert body["face_detected"] is True, "a blurred face is still a face"


def test_a_frame_blurred_past_usefulness_is_still_dropped(client, faces):
    """The floor is lowered for liveness, not removed.

    Far below the liveness threshold the landmark geometry is noise, and
    scoring it would invent blinks out of nothing.
    """
    session_id = client.post("/verify/start").json()["session_id"]
    mush = _to_b64(cv2.GaussianBlur(faces[0], (61, 61), 0))

    for _ in range(settings.max_consecutive_missing_face + 2):
        body = client.post(
            "/verify/frame", json={"session_id": session_id, "image_b64": mush}
        ).json()

    assert body["face_detected"] is False
    assert body["failure_reason"] == "face_lost"


def test_a_still_frame_makes_no_liveness_progress(client, faces):
    """A held photo satisfies no action, whatever the challenge happens to be."""
    session_id = client.post("/verify/start").json()["session_id"]
    frame = _to_b64(faces[0])

    for _ in range(12):
        body = client.post(
            "/verify/frame", json={"session_id": session_id, "image_b64": frame}
        ).json()

    assert body["status"] == "in_progress"
    assert body["ready_to_match"] is False
    assert body["step_index"] == 0


def test_verification_rejects_an_unknown_session(client, faces):
    response = client.post(
        "/verify/frame",
        json={"session_id": "does-not-exist", "image_b64": _to_b64(faces[0])},
    )
    assert response.status_code == 404


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
