"""Live webcam view of every signal the liveness check runs on.

Run this before touching a single threshold in config.py. The defaults there
are starting points from the literature, not measurements of *your* face under
*your* lighting — and eye shape varies enough between people that a default EAR
threshold can reject someone who is blinking perfectly well.

    python tools/live_check.py

On start it spends a second learning where your head and eyes sit at rest, so
hold still and look at the camera until the calibrating line disappears. After
that everything is reported as movement away from that rest position, which is
exactly how the liveness check scores it.

    python tools/live_check.py

Keys:
    c  start a fresh randomised challenge
    r  re-learn the rest position and clear the readings
    q  quit — prints suggested config values

What to do, in order:

  1. Hold still until calibration finishes.

  2. Blink deliberately, several times. Watch the EAR range: you need to see a
     clear floor well below your open-eye value. If the range stays flat, your
     blinks are not being caught.

  3. Turn your head left, hold a second, then right, hold a second. Then do the
     same with your eyes alone, keeping your head still. Both GAZE and YAW
     should show movement — the challenge accepts either, since some people
     turn their head and others swivel their eyes.

  4. Wave a hand to watch SHARP collapse; anything under `min_sharpness` is
     discarded before detection runs.

Quitting prints thresholds derived from what you actually did.
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


BASELINE_FRAMES = 30


class Readings:
    """Rest position plus running extremes.

    Liveness scores movement away from rest, not absolute position, so the
    number that matters when setting a threshold is how far each signal
    travelled from the baseline — not where it ended up.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.extremes: dict[str, tuple[float, float]] = {}
        self.baseline: dict[str, float] = {}
        self._samples: dict[str, list[float]] = {}

    @property
    def calibrating(self) -> bool:
        return not self.baseline

    def update(self, **values: float) -> None:
        # Absolute extremes are tracked for every signal, because EAR is
        # thresholded absolutely — the blink floor is the number that matters
        # there. Gaze and yaw shifts are derived from these against the
        # baseline, since liveness scores those on movement instead.
        for name, value in values.items():
            low, high = self.extremes.get(name, (value, value))
            self.extremes[name] = (min(low, value), max(high, value))

            if self.calibrating:
                self._samples.setdefault(name, []).append(value)

        if self.calibrating and self.calibration_progress() >= 1.0:
            self.baseline = {name: sum(s) / len(s) for name, s in self._samples.items()}

    def calibration_progress(self) -> float:
        if not self._samples:
            return 0.0
        return min(len(s) for s in self._samples.values()) / BASELINE_FRAMES

    def shift(self, name: str, value: float) -> float:
        """How far this signal has moved from rest."""
        return value - self.baseline.get(name, value)

    def absolute_span(self, name: str) -> tuple[float, float] | None:
        return self.extremes.get(name)

    def shift_span(self, name: str) -> tuple[float, float] | None:
        """Extremes expressed as movement away from rest."""
        span = self.extremes.get(name)
        if span is None or name not in self.baseline:
            return None
        rest = self.baseline[name]
        return span[0] - rest, span[1] - rest

    def span(self, name: str, *, absolute: bool = False) -> str:
        span = self.absolute_span(name) if absolute else self.shift_span(name)
        if span is None:
            return f"{name:<5} --"

        low, high = span
        if absolute:
            return f"{name:<5} {low:.3f} .. {high:.3f}"
        return f"{name:<5} {low:+.3f} .. {high:+.3f} from rest"


FONT = cv2.FONT_HERSHEY_SIMPLEX
LINE_HEIGHT = 22


def draw(frame, lines: list[tuple[str, tuple[int, int, int]]]) -> None:
    """Overlay the readings on a dimmed panel.

    A thick dark outline behind each glyph was the obvious way to keep text
    readable over a bright face, but at this font size the stroke is wide
    enough that adjacent letters merge and the text reads as doubled. Dimming
    the region behind the text instead keeps the strokes thin and crisp.
    """
    if not lines:
        return

    panel_height = min(LINE_HEIGHT * len(lines) + 12, frame.shape[0])
    panel_width = min(440, frame.shape[1])

    region = frame[:panel_height, :panel_width]
    region[:] = (region * 0.35).astype(region.dtype)

    for i, (text, colour) in enumerate(lines):
        y = 20 + i * LINE_HEIGHT
        cv2.putText(frame, text, (10, y), FONT, 0.48, colour, 1, cv2.LINE_AA)


def open_camera(index: int = 0):
    """Open the webcam, preferring the backend that starts quickly.

    On Windows the default MSMF backend routinely takes ten seconds or more to
    open a camera, and reports `isOpened()` before it can actually deliver a
    frame — so this also pulls one frame to confirm the device really works.
    """
    backends = (
        [(cv2.CAP_DSHOW, "DirectShow"), (cv2.CAP_ANY, "default")]
        if sys.platform == "win32"
        else [(cv2.CAP_ANY, "default")]
    )

    for backend, name in backends:
        camera = cv2.VideoCapture(index, backend)
        if camera.isOpened() and camera.read()[0]:
            print(f"camera ready via {name}", flush=True)
            return camera
        camera.release()

    return None


def main() -> int:
    print(__doc__)

    # Load before touching the camera. The model takes a second or two, and
    # doing it inside the loop means the window does not appear until after it
    # finishes — which looks exactly like a hang.
    print("loading face mesh model...", flush=True)
    face_detection.warm_up()

    print("opening camera...", flush=True)
    camera = open_camera()
    if camera is None:
        print("Could not open the webcam. Is another application using it?")
        return 1

    print("press 'c' to run a challenge, 'r' to reset, 'q' to quit", flush=True)
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
                readings.update(
                    ear=geometry.ear,
                    gaze=geometry.gaze_horizontal,
                    yaw=geometry.head_yaw,
                )

                eyes_open = geometry.ear >= settings.ear_threshold
                lines.append(
                    (
                        f"EAR   {geometry.ear:.3f}  thr {settings.ear_threshold}"
                        f"   {'open' if eyes_open else 'CLOSED'}",
                        GREEN if eyes_open else AMBER,
                    )
                )

                if readings.calibrating:
                    percent = int(readings.calibration_progress() * 100)
                    lines.append(
                        (f"holding still to learn rest position... {percent}%", AMBER)
                    )
                else:
                    for label, key, value, delta in (
                        ("GAZE", "gaze", geometry.gaze_horizontal, settings.gaze_delta),
                        ("YAW ", "yaw", geometry.head_yaw, settings.yaw_delta),
                    ):
                        shift = readings.shift(key, value)
                        triggered = abs(shift) >= delta
                        lines.append(
                            (
                                f"{label}  {value:.3f}   moved {shift:+.3f}"
                                f"  (needs +-{delta})"
                                f"   {'TRIGGERED' if triggered else ''}",
                                GREEN if triggered else WHITE,
                            )
                        )

                lines += [
                    (
                        f"SHARP {sharpness:6.1f}  min {settings.min_sharpness}",
                        GREEN if sharpness >= settings.min_sharpness else RED,
                    ),
                    ("", WHITE),
                    ("range observed:", WHITE),
                    (f"  {readings.span('ear', absolute=True)}", WHITE),
                    (f"  {readings.span('gaze')}", WHITE),
                    (f"  {readings.span('yaw')}", WHITE),
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

    suggest(readings)
    return 0


def suggest(readings: Readings) -> None:
    """Turn the observed readings into config values.

    Movement thresholds are set to 60% of the smaller of the two directions
    measured. Taking the smaller one matters: if you turned further left than
    right, a threshold built from the left swing would be unreachable to the
    right. The 40% headroom absorbs the difference between a deliberate turn
    while calibrating and a casual one at a real kiosk.
    """
    print("\n" + "=" * 60)
    if not readings.extremes:
        print("No face was measured, so there is nothing to suggest.")
        print("=" * 60)
        return

    ear = readings.absolute_span("ear")
    if ear and ear[1] - ear[0] < 0.08:
        print(
            f"EAR range was only {ear[0]:.3f}..{ear[1]:.3f} (spread"
            f" {ear[1] - ear[0]:.3f}).\n"
            "  Too flat to contain a blink — the eyes never actually closed.\n"
            "  Re-run and blink deliberately several times."
        )
    elif ear:
        # Halfway between the blink floor and the resting open value.
        print(
            f"  ear_threshold = {(ear[0] + ear[1]) / 2:.2f}"
            f"      (blink floor {ear[0]:.3f}, open {ear[1]:.3f})"
        )

    for name, key, floor in (("gaze", "gaze_delta", 0.03), ("yaw", "yaw_delta", 0.02)):
        span = readings.shift_span(name)
        if span is None:
            print(f"{name.upper()}: never calibrated — hold still for a second first.")
            continue

        low, high = span
        reachable = min(abs(low), abs(high))
        if reachable < floor:
            print(
                f"{name.upper()} moved {low:+.3f}..{high:+.3f} from rest — only"
                f" {reachable:.3f} in the weaker direction.\n"
                f"  Look hard to *both* sides and hold each for a second, then re-run."
            )
            continue

        print(f"  {key:<13} = {0.6 * reachable:.2f}      (moved {low:+.3f}..{high:+.3f})")

    print("=" * 60)


if __name__ == "__main__":
    sys.exit(main())
