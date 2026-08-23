"""Can face *geometry* identify anyone? Measured, on the same faces.

The question this answers
-------------------------
The service runs two completely different face models, and the obvious
objection is that one of them ought to be enough. MediaPipe already returns 478
precise points per face -- eyes, nose, jaw, the whole mesh. Surely the distances
between those points describe a face well enough to recognise it, and the extra
300MB of ArcFace is redundant?

That was, roughly, how face recognition worked before deep learning: measure the
geometry and compare the measurements. So rather than assert that it does not
work, this measures it, on the same images, with the same genuine and impostor
pairs, against the same ArcFace embeddings the system actually stores.

The geometric descriptor here is a generous version of the idea. Not a handful
of hand-picked ratios -- the entire 468-point mesh, Procrustes-normalised so
that position, scale and in-plane rotation are removed and only the *shape* of
the face remains. If landmark geometry can identify people at all, this is
close to the best case for it.

    python tools/landmarks_vs_arcface.py --root ../benchmark-data/lfw_funneled \\
        --identities 250
"""

import argparse
import statistics
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import face_detection  # noqa: E402
import preprocessing  # noqa: E402
import recognition  # noqa: E402

# The iris ring is refined per-frame from the eye region and moves with gaze
# rather than with bone structure, so it is left out of a shape descriptor.
MESH_POINTS = 468


def procrustes(points: np.ndarray) -> np.ndarray:
    """Strip out position, scale and in-plane rotation, leaving shape alone.

    Without this the descriptor would be dominated by how far the person stood
    from the camera and how they tilted their head, which says nothing about who
    they are. Removing all three is what makes the comparison a fair test of the
    geometric idea rather than a test of camera framing.
    """
    centred = points - points.mean(axis=0)

    scale = np.sqrt((centred**2).sum() / len(centred))
    if scale == 0:
        return centred.ravel()
    centred = centred / scale

    # Align the eye axis to horizontal. Any consistent reference does, and the
    # outer eye corners are the two most stable points in the mesh.
    axis = centred[263] - centred[33]
    angle = np.arctan2(axis[1], axis[0])
    cos, sin = np.cos(-angle), np.sin(-angle)
    rotation = np.array([[cos, -sin], [sin, cos]], dtype=np.float32)

    return (centred @ rotation.T).ravel()


def unit(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    return vector / norm if norm else vector


def describe(path: Path) -> tuple[np.ndarray, np.ndarray] | None:
    """Both descriptors for one image: mesh shape, and the ArcFace embedding."""
    image = preprocessing.decode_image(path.read_bytes())
    if image is None:
        return None

    normalised = preprocessing.normalize_lighting(image)

    faces = recognition.detect_faces(normalised)
    if len(faces) != 1:
        return None

    geometry = face_detection.analyse(normalised)
    if geometry is None:
        return None

    shape = unit(procrustes(geometry.landmarks[:MESH_POINTS].astype(np.float32)))
    return shape, faces[0].embedding


def report(name: str, genuine: list[float], impostor: list[float]) -> dict:
    genuine_sorted = sorted(genuine)
    impostor_sorted = sorted(impostor)

    def pct(values: list[float], p: float) -> float:
        return values[min(int(p * len(values)), len(values) - 1)]

    # Equal error rate: sweep every threshold the data suggests and find where
    # the two mistakes cost the same. It is the standard single number for
    # comparing two biometrics, and it does not depend on either system's
    # operating threshold.
    best = (1.0, 1.0, 0.0)  # (gap, error, threshold)
    for threshold in np.linspace(-1, 1, 4001):
        frr = sum(1 for g in genuine if g < threshold) / len(genuine)
        far = sum(1 for i in impostor if i >= threshold) / len(impostor)
        gap = abs(frr - far)
        if gap < best[0]:
            best = (gap, (frr + far) / 2, threshold)

    # d-prime: how many standard deviations separate the two distributions.
    gm, im = statistics.mean(genuine), statistics.mean(impostor)
    gs, isd = statistics.pstdev(genuine), statistics.pstdev(impostor)
    dprime = abs(gm - im) / np.sqrt((gs**2 + isd**2) / 2) if (gs or isd) else 0.0

    print(f"\n{name}")
    print(f"  genuine    median {statistics.median(genuine):+.4f}   "
          f"p5 {pct(genuine_sorted, 0.05):+.4f}   min {genuine_sorted[0]:+.4f}")
    print(f"  impostor   median {statistics.median(impostor):+.4f}   "
          f"p95 {pct(impostor_sorted, 0.95):+.4f}   max {impostor_sorted[-1]:+.4f}")
    print(f"  overlap    lowest genuine {genuine_sorted[0]:+.4f} vs "
          f"highest impostor {impostor_sorted[-1]:+.4f}")
    print(f"  d-prime    {dprime:.2f}      (separation in standard deviations)")
    print(f"  EER        {best[1]:.2%}    (equal error rate, at threshold {best[2]:+.3f})")

    return {"dprime": round(float(dprime), 2), "eer": round(best[1], 5)}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--root", required=True)
    parser.add_argument("--identities", type=int, default=250)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    people = []
    for person in sorted(p for p in root.iterdir() if p.is_dir()):
        images = sorted(person.glob("*.jpg"))
        if len(images) >= 2:
            people.append((person.name, images[:2]))
        if len(people) >= args.identities:
            break

    print(f"{len(people)} identities with two images each")
    recognition.warm_up()
    face_detection.warm_up()

    pairs = []
    for index, (name, images) in enumerate(people, start=1):
        both = [describe(p) for p in images]
        if any(b is None for b in both):
            continue
        pairs.append((name, both[0], both[1]))
        if index % 50 == 0:
            print(f"  {index}/{len(people)}  usable={len(pairs)}")

    print(f"\n{len(pairs)} identities gave a usable pair of both descriptors")

    shape_genuine, arc_genuine = [], []
    for _name, first, second in pairs:
        shape_genuine.append(float(first[0] @ second[0]))
        arc_genuine.append(float(first[1] @ second[1]))

    shape_impostor, arc_impostor = [], []
    for i in range(len(pairs)):
        for j in range(i + 1, len(pairs)):
            shape_impostor.append(float(pairs[i][1][0] @ pairs[j][1][0]))
            arc_impostor.append(float(pairs[i][1][1] @ pairs[j][1][1]))

    print(f"{len(shape_genuine)} genuine pairs, {len(shape_impostor):,} impostor pairs")

    mesh = report("MediaPipe mesh shape (468 points, Procrustes-normalised)",
                  shape_genuine, shape_impostor)
    arc = report("ArcFace embedding (512-d, w600k_r50)", arc_genuine, arc_impostor)

    print("\n" + "=" * 68)
    print(
        f"d-prime {arc['dprime']} against {mesh['dprime']}: ArcFace separates the "
        f"same faces roughly {arc['dprime'] / max(mesh['dprime'], 1e-9):.0f}x more "
        f"strongly.\nEER {arc['eer']:.2%} against {mesh['eer']:.2%}, where a coin "
        "flip is 50%."
    )
    # Deliberately not phrased as a ratio of the two error rates. One of them is
    # zero on a sample this size, and dividing by it manufactures a number with
    # no meaning behind it.
    print(
        "\nThe line that explains the rest is the impostor median. Two *different*"
        f"\npeople score {statistics.median(shape_impostor):.4f} against each other in mesh shape,"
        "\nbecause a canonical face mesh exists to make every face the same shape."
        "\nWhat survives that fitting is not identity."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
