"""Does an eye give itself away when the face is holding still?

The idea
--------
A photograph's gaze is fixed forever: the irises sit where the shutter left
them. A living eye never holds still -- microsaccades move it one to two
degrees several times a second, and the eyelids drift even between blinks.

Both are already measured. `gaze_horizontal` is the iris centre's position
along the axis between that eye's own corners, and `ear` is eyelid opening over
eye width. Both are ratios *within the eye*, which is the property that makes
this worth testing: they do not change when a photograph is moved closer, or
sideways, or shaken in somebody's hand. Only the eye itself changes them.

The measurement
---------------
Real passive scans already log the range of both over their window. Against
twelve of them, people standing still for about a second and a half:

    gaze range   0.032 to 0.168
    ear range    0.042 to 0.174

What is missing is the other side: how much a *photograph* appears to move
under the same measurement, once camera noise and an unsteady hand have had
their say. That is what this simulates, deliberately generously -- a hand
shakes by several pixels and tilts a degree or two, and the sensor adds noise
on every frame.

If a held photograph stays well under 0.032, this separates and it is a passive
check that needs nothing from the person. If it does not, it goes the way of
the planar test, and for the same reason: a control is only as good as its
worst case, not its median.

    python tools/micromotion_check.py --root ../benchmark-data/lfw_funneled
"""

import argparse
import statistics
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import face_detection  # noqa: E402
import preprocessing  # noqa: E402
import recognition  # noqa: E402

# What a real passive scan produces, measured from live sessions. The lowest
# any of them fell to is the bar a photograph has to stay under.
LIVE_GAZE_FLOOR = 0.032
LIVE_EAR_FLOOR = 0.042


def held_frame(image: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """One frame of a photograph being held up to a camera.

    Generous on purpose. Anything that makes the photograph look *more* alive
    biases the result against the check, and a check that survives a biased
    test is worth something -- one that only passes a flattering one is not.
    """
    height, width = image.shape[:2]

    # An unsteady hand: a few pixels of drift and a degree or two of roll.
    shift_x, shift_y = rng.normal(0, 3.0, size=2)
    angle = rng.normal(0, 1.5)
    scale = 1.0 + rng.normal(0, 0.004)  # drifting nearer and further

    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, scale)
    matrix[0, 2] += shift_x
    matrix[1, 2] += shift_y
    moved = cv2.warpAffine(
        image, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE
    )

    # Sensor noise, so no two frames are ever the same bytes.
    noise = rng.normal(0, 2.5, moved.shape)
    return np.clip(moved.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def scan(image: np.ndarray, frames: int, rng: np.random.Generator):
    """Ranges of gaze and EAR across a simulated hold of a photograph."""
    gazes, ears = [], []

    for _ in range(frames):
        geometry = face_detection.analyse(
            preprocessing.normalize_lighting(held_frame(image, rng))
        )
        if geometry is None:
            continue
        gazes.append(geometry.gaze_horizontal)
        ears.append(geometry.ear)

    if len(gazes) < 3:
        return None, None
    return max(gazes) - min(gazes), max(ears) - min(ears)


def summarise(name: str, values: list[float], floor: float) -> None:
    values = sorted(v for v in values if v is not None)
    if not values:
        print(f"\n{name}: nothing measurable")
        return

    def pct(p: float) -> float:
        return values[min(int(p * len(values)), len(values) - 1)]

    print(f"\n{name}  (n = {len(values)})")
    print(f"  min     {values[0]:.4f}")
    print(f"  median  {statistics.median(values):.4f}")
    print(f"  p90     {pct(0.90):.4f}")
    print(f"  p99     {pct(0.99):.4f}")
    print(f"  max     {values[-1]:.4f}")

    over = sum(1 for v in values if v >= floor)
    print(f"\n  live sessions never fell below {floor:.4f}")
    print(f"  {over}/{len(values)} held photographs reach it ({over / len(values):.1%})")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--root", required=True)
    parser.add_argument("--identities", type=int, default=60)
    parser.add_argument(
        "--frames", type=int, default=26, help="frames per hold; live scans run 26"
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    recognition.warm_up()
    face_detection.warm_up()

    rng = np.random.default_rng(20260823)
    gaze_ranges, ear_ranges = [], []

    people = [p for p in sorted(root.iterdir()) if p.is_dir()]
    used = 0

    for person in people:
        if used >= args.identities:
            break
        shots = sorted(person.glob("*.jpg"))
        if not shots:
            continue

        image = preprocessing.decode_image(shots[0].read_bytes())
        if image is None:
            continue

        gaze_range, ear_range = scan(image, args.frames, rng)
        if gaze_range is None:
            continue

        gaze_ranges.append(gaze_range)
        ear_ranges.append(ear_range)
        used += 1
        if used % 20 == 0:
            print(f"  {used}/{args.identities}")

    print(f"\n{used} photographs held for {args.frames} frames each")

    summarise("GAZE range -- photograph held in the hand", gaze_ranges, LIVE_GAZE_FLOOR)
    summarise("EAR range  -- photograph held in the hand", ear_ranges, LIVE_EAR_FLOOR)

    print("\n" + "=" * 64)
    gaze_over = sum(1 for v in gaze_ranges if v >= LIVE_GAZE_FLOOR) / max(len(gaze_ranges), 1)
    ear_over = sum(1 for v in ear_ranges if v >= LIVE_EAR_FLOOR) / max(len(ear_ranges), 1)

    if gaze_over <= 0.02 or ear_over <= 0.02:
        best = "gaze" if gaze_over <= ear_over else "EAR"
        print(f"WORTH BUILDING on {best}. Held photographs stay under the floor")
        print("every live scan cleared, so a threshold exists that costs real")
        print("customers nothing. Needs a real held photograph on a real camera")
        print("before it is trusted -- this is a simulated hand, not a hand.")
    else:
        print("NOT SEPARABLE. A held photograph produces as much apparent eye")
        print("movement as a person standing still, so no threshold divides")
        print("them. The ratios are measured within the eye, but landmark noise")
        print("on a moving image moves them as much as a living eye does.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
