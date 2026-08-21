"""Live webcam view of every signal the liveness check runs on.

Run this before touching a single threshold in config.py. The defaults there
are starting points from the literature, not measurements of *your* face under
*your* lighting — and eye shape varies enough between people that a default EAR
threshold can reject someone who is blinking perfectly well.

    python tools/live_check.py

Keys:
    c  start a fresh randomised challenge
    r  reset the observed min/max readings
    q  quit

What to look for:

  EAR   Watch the min/max readout with your eyes open, then blink a few times.
        A good `ear_threshold` sits roughly halfway between your open-eye
        resting value and the floor your blinks reach.

  GAZE  Look hard left, then hard right, and note the extremes. Set
        `gaze_ratio_low` and `gaze_ratio_high` just inside those, so a real
        glance clears them but a centred gaze does not.

  SHARP Wave your hand or move quickly to see the value collapse. Anything
        below `min_sharpness` is discarded before detection runs.
"""

import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import face_detection
import preprocessing
from config import settings
from liveness import LivenessSession, LivenessStatus

WINDOW = "FacePay - live signals"
GREEN, RED, AMBER, WHITE = (0, 220, 0), (0, 0, 255), (0, 190, 255), (240, 240, 240)


class Readings:
    """Running extremes, which is what the thresholds are actually set from."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.ear_min = self.gaze_min = float("inf")
        self.ear_max = self.gaze_max = float("-inf")

    def update(self, ear: float, gaze: float) -> None:
        self.ear_min, self.ear_max = min(self.ear_min, ear), max(self.ear_max, ear)
        self.gaze_min, self.gaze_max = min(self.gaze_min, gaze), max(self.gaze_max, gaze)

    def line(self, label: str, low: float, high: float) -> str:
        if low == float("inf"):
            return f"{label} observed --"
        return f"{label} observed {low:.3f} .. {high:.3f}"


def draw(frame, lines: list[tuple[str, tuple[int, int, int]]]) -> None:
    for i, (text, colour) in enumerate(lines):
        y = 28 + i * 26
        # Dark outline first so the text stays readable over a bright face.
        cv2.putText(frame, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4)
        cv2.putText(frame, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 1)


def main() -> int:
    camera = cv2.VideoCapture(0)
    if not camera.isOpened():
        print("Could not open the webcam. Is another application using it?")
        return 1

    print(__doc__)
    readings = Readings()
    session: LivenessSession | None = None

    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                print("Dropped frame from the camera.")
                break

            sharpness = preprocessing.measure_sharpness(frame)
            normalised = preprocessing.normalize_lighting(frame)
            geometry = face_detection.analyse(normalised)

            lines: list[tuple[str, tuple[int, int, int]]] = []

            if geometry is None:
                lines.append(("NO FACE DETECTED", RED))
            else:
                readings.update(geometry.ear, geometry.gaze_horizontal)

                eyes_open = geometry.ear >= settings.ear_threshold
                lines += [
                    (
                        f"EAR   {geometry.ear:.3f}  (threshold {settings.ear_threshold})"
                        f"  {'open' if eyes_open else 'CLOSED'}",
                        GREEN if eyes_open else AMBER,
                    ),
                    (
                        f"GAZE  {geometry.gaze_horizontal:.3f}"
                        f"  (low {settings.gaze_ratio_low} / high {settings.gaze_ratio_high})",
                        WHITE,
                    ),
                    (
                        f"SHARP {sharpness:6.1f}  (minimum {settings.min_sharpness})",
                        GREEN if sharpness >= settings.min_sharpness else RED,
                    ),
                    (readings.line("EAR ", readings.ear_min, readings.ear_max), WHITE),
                    (readings.line("GAZE", readings.gaze_min, readings.gaze_max), WHITE),
                ]

                # Draw the iris centres — if these do not sit on your pupils,
                # the landmark indices are wrong and gaze cannot be trusted.
                for index in (
                    face_detection.IMG_LEFT_IRIS_CENTRE,
                    face_detection.IMG_RIGHT_IRIS_CENTRE,
                ):
                    x, y = geometry.landmarks[index]
                    cv2.circle(frame, (int(x), int(y)), 3, GREEN, -1)

            if session is not None:
                session.submit_frame(geometry)
                outcome = session.outcome()

                colour = {
                    LivenessStatus.PASSED: GREEN,
                    LivenessStatus.FAILED: RED,
                    LivenessStatus.IN_PROGRESS: AMBER,
                }[outcome.status]

                label = outcome.failure_reason or outcome.prompt or "complete"
                lines.append(("", WHITE))
                lines.append(
                    (
                        f"[{outcome.status.value}] step "
                        f"{min(outcome.step_index + 1, outcome.total_steps)}"
                        f"/{outcome.total_steps} - {label}",
                        colour,
                    )
                )
                lines.append(
                    (
                        f"progress {'#' * int(outcome.step_progress * 20):<20}"
                        f" blinks={session.signals.blinks_detected}",
                        colour,
                    )
                )
            else:
                lines.append(("", WHITE))
                lines.append(("press 'c' to run a challenge, 'r' reset, 'q' quit", WHITE))

            draw(frame, lines)
            cv2.imshow(WINDOW, frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("c"):
                session = LivenessSession(session_id="live-check")
                print(f"challenge: {[s.prompt for s in session.challenge]}")
            if key == ord("r"):
                readings.reset()
                session = None
    finally:
        camera.release()
        cv2.destroyAllWindows()

    print("\nSuggested config.py values from this run:")
    if readings.ear_min != float("inf"):
        print(f"  ear_threshold   ~ {(readings.ear_min + readings.ear_max) / 2:.2f}")
        print(f"  gaze_ratio_low  ~ {readings.gaze_min + 0.05:.2f}")
        print(f"  gaze_ratio_high ~ {readings.gaze_max - 0.05:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
