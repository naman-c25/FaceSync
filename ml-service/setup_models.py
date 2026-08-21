"""One-time model download.

Run this once after installing dependencies:

    python setup_models.py

Two model sets are needed and neither ships with its package:

- MediaPipe's FaceLandmarker bundle, fetched from Google's model storage.
- InsightFace's buffalo_l pack, which the library downloads itself on first
  use. Pulling it here rather than on the first request keeps a cold start
  from looking like a hang during a demo.
"""

import sys
import urllib.request
from pathlib import Path

from config import BASE_DIR, settings

FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
FACE_LANDMARKER_PATH = BASE_DIR / "models" / "face_landmarker.task"


def fetch_face_landmarker() -> None:
    if FACE_LANDMARKER_PATH.exists():
        size_mb = FACE_LANDMARKER_PATH.stat().st_size / 1_000_000
        print(f"[skip] face_landmarker.task already present ({size_mb:.1f} MB)")
        return

    FACE_LANDMARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"[fetch] {FACE_LANDMARKER_URL}")
    urllib.request.urlretrieve(FACE_LANDMARKER_URL, FACE_LANDMARKER_PATH)

    size_mb = FACE_LANDMARKER_PATH.stat().st_size / 1_000_000
    print(f"[done]  face_landmarker.task ({size_mb:.1f} MB)")


def fetch_insightface() -> None:
    print(f"[fetch] InsightFace '{settings.insightface_model}' (~300 MB on first run)")

    import recognition

    recognition.warm_up()
    print(f"[done]  models cached under {settings.insightface_root}")


def main() -> int:
    try:
        fetch_face_landmarker()
        fetch_insightface()
    except Exception as exc:
        print(f"\n[error] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print("\nAll models ready. Start the service with: python app.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
