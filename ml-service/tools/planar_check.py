"""Can the face mesh tell a real face from a photograph of one?

The idea
--------
A real face is a three-dimensional object and a photograph is a plane. When a
head turns, the 2D landmark configuration deforms in a way no flat surface can
reproduce: near features slide across far ones and the far side foreshortens.
When a *photograph* is tilted, every point moves under one homography, because
that is what a plane does.

So: align two views of the same thing with the best-fitting homography and look
at what is left over. A real face should leave a large residual. A photograph
should leave almost none.

The risk this measures
----------------------
MediaPipe's landmarks are not raw observations. They come from fitting a 3D
morphable face model to the image, and that model has been trained to believe
faces are three-dimensional. It may well hallucinate depth for a flat picture,
which would flatten the very difference this depends on and kill the approach.

That is the question here, and it can be answered without filming anything:

  planar pairs   one image, and the same image warped by a known homography --
                 exactly what a photograph held at a different angle looks like

  real pairs     two photographs of the same person at different head poses,
                 which are genuine 3D rotations of a real face

The real pairs also differ in expression and lighting, which inflates their
residual for reasons that have nothing to do with depth. That bias runs in the
direction of making this look better than it is, so a *negative* result here is
conclusive and a positive one still needs live footage before it is trusted.

    python tools/planar_check.py --root ../benchmark-data/lfw_funneled
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

MESH_POINTS = 468


def residual(a: np.ndarray, b: np.ndarray) -> float:
    """Pixels of landmark movement the best-fitting homography cannot explain.

    Normalised by the inter-ocular distance so a face nearer the camera does not
    simply score higher than one further away.
    """
    matrix, _ = cv2.findHomography(a, b, cv2.RANSAC, 5.0)
    if matrix is None:
        return float("nan")

    projected = cv2.perspectiveTransform(a.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    error = np.linalg.norm(projected - b, axis=1)

    scale = float(np.linalg.norm(b[33] - b[263]))  # outer eye corners
    return float(np.median(error) / scale) if scale else float("nan")


def mesh(image: np.ndarray) -> np.ndarray | None:
    geometry = face_detection.analyse(preprocessing.normalize_lighting(image))
    if geometry is None:
        return None
    return geometry.landmarks[:MESH_POINTS].astype(np.float32)


def tilt(image: np.ndarray, strength: float) -> np.ndarray:
    """Warp an image as though the flat photograph of it were turned.

    A perspective transform is exactly the transformation a plane undergoes, so
    this is what the camera genuinely sees when someone holds a print at an
    angle -- not an approximation of it.
    """
    height, width = image.shape[:2]
    source = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
    shift = width * strength
    target = np.float32(
        [[shift, shift * 0.4], [width, 0], [width - shift, height - shift * 0.4], [0, height]]
    )
    return cv2.warpPerspective(
        image, cv2.getPerspectiveTransform(source, target), (width, height)
    )


def summarise(name: str, values: list[float]) -> dict:
    clean = [v for v in values if not np.isnan(v)]
    if not clean:
        print(f"\n{name}: nothing measurable")
        return {}

    clean.sort()
    stats = {
        "n": len(clean),
        "median": statistics.median(clean),
        "p10": clean[max(int(0.10 * len(clean)) - 1, 0)],
        "p90": clean[min(int(0.90 * len(clean)), len(clean) - 1)],
        "min": clean[0],
        "max": clean[-1],
    }
    print(f"\n{name}  (n = {stats['n']})")
    for key in ("min", "p10", "median", "p90", "max"):
        print(f"  {key:7} {stats[key]:.4f}")
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--root", required=True)
    parser.add_argument("--identities", type=int, default=120)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    recognition.warm_up()
    face_detection.warm_up()

    planar: list[float] = []
    real: list[float] = []

    people = [p for p in sorted(root.iterdir()) if p.is_dir()]
    used = 0

    for person in people:
        if used >= args.identities:
            break
        shots = sorted(person.glob("*.jpg"))
        if len(shots) < 2:
            continue

        first = preprocessing.decode_image(shots[0].read_bytes())
        second = preprocessing.decode_image(shots[1].read_bytes())
        if first is None or second is None:
            continue

        mesh_first = mesh(first)
        mesh_second = mesh(second)
        if mesh_first is None or mesh_second is None:
            continue

        # A real 3D face, photographed twice at different poses.
        real.append(residual(mesh_first, mesh_second))

        # The same face as a flat print, held at a different angle. Two tilts so
        # the pair is two *views of a photograph*, matching what the real pair
        # is: two views of a face.
        warped_a = mesh(tilt(first, 0.06))
        warped_b = mesh(tilt(first, -0.10))
        if warped_a is not None and warped_b is not None:
            planar.append(residual(warped_a, warped_b))

        used += 1
        if used % 40 == 0:
            print(f"  {used}/{args.identities}")

    print(f"\n{used} identities measured")

    flat = summarise("PLANAR  -- a photograph held at two angles", planar)
    solid = summarise("REAL    -- one person's face at two poses", real)

    if not flat or not solid:
        return 1

    # Percentiles are not the test. A threshold has to be chosen, and what
    # decides whether this is usable is what that threshold costs at the tails
    # -- which is where an attacker lives.
    print("\n" + "=" * 64)
    print("What a threshold would actually cost\n")
    print(f"{'threshold':>10} {'photos accepted':>17} {'real faces rejected':>21}")

    clean_flat = sorted(v for v in planar if not np.isnan(v))
    clean_real = sorted(v for v in real if not np.isnan(v))
    for t in (0.012, 0.015, 0.018, 0.020, 0.025, 0.030):
        far = sum(1 for v in clean_flat if v >= t) / len(clean_flat)
        frr = sum(1 for v in clean_real if v < t) / len(clean_real)
        print(f"{t:>10.3f} {far:>16.1%} {frr:>20.1%}")

    # The verdict is the error table, not the percentiles. p10 above p90 reads
    # as separation and says nothing about the tails, and the tails are the
    # whole question for a security control.
    print("\n" + "=" * 64)
    usable = [
        t
        for t in (0.012, 0.015, 0.018, 0.020, 0.025, 0.030)
        if sum(1 for v in clean_flat if v >= t) / len(clean_flat) <= 0.01
        and sum(1 for v in clean_real if v < t) / len(clean_real) <= 0.05
    ]

    if usable:
        print(f"USABLE at threshold {usable[0]:.3f}: under 1% of photographs")
        print("accepted for under 5% of real faces rejected.")
        print("Still needs live footage before it is trusted.")
    else:
        print("NOT USABLE as a gate. No threshold blocks photographs without")
        print("rejecting real people at a rate a till could live with. The")
        print("distributions overlap far into the tails, and the tails are the")
        print("only part a security control is about.")
        print("\nAnd this test flatters the method. The real pairs are two press")
        print("photographs taken years apart, differing in pose, expression and")
        print("lighting far more than one person holding still for a second and")
        print("a half at a kiosk ever would. Less movement means less")
        print("deformation, which pushes real faces down into the range the")
        print("photographs already occupy. Live capture would separate worse")
        print("than this, not better.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
