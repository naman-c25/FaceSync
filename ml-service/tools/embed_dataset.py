"""Turn a directory of face images into embeddings, for measuring accuracy at scale.

Why this exists
---------------
Live enrollment gives us a handful of real people. A handful cannot answer the
question the whole design rests on: does 1:N identification still hold when N is
large? The system-level false match rate grows roughly as N x the per-comparison
rate, so "no false matches against eight people" is close to no evidence at all.
Filling the gallery with thousands of real, distinct faces and re-measuring is
the only way to say anything honest about it.

Images are read from disk in the usual one-directory-per-person layout:

    root/
      Person_Name/
        Person_Name_0001.jpg
        Person_Name_0002.jpg

Each identity becomes one JSONL row: a fused gallery embedding built from the
first few images, plus any remaining images kept aside as probes. Two images of
the same person taken on different days are exactly what a genuine-pair
measurement needs, and holding them out of the fused vector is what stops the
measurement from grading its own work.

Where this deliberately differs from the live pipeline
------------------------------------------------------
Two gates are relaxed, and both relaxations are about the dataset rather than
about recognition:

*   Multiple faces. A kiosk rejects a frame with two faces in it, because it
    cannot know which person is paying. In a labelled dataset we already know:
    the subject is the one the image is named after, and in an aligned dataset
    they are centred by construction. So the largest, most central face is taken
    rather than the image being thrown away. Press photographs very often have a
    bystander in shot, and rejecting those would quietly bias the gallery toward
    people who get photographed alone.

*   Sharpness. --min-sharpness defaults to the live threshold but is meant to be
    set after looking at what the run reports. A 250x250 JPEG downscaled from a
    press photo measures far less Laplacian variance than a webcam frame of the
    same real sharpness, so the live number would be measuring the dataset's
    resolution rather than whether the face is usable. Run --report-only first
    and choose from the distribution.

Nothing else is loosened. Detection, alignment, embedding and the quality
measurements are the same code the running service uses, imported directly. If
this file and the service ever disagreed about how a face becomes a vector,
every number produced here would be meaningless.

Usage
-----
    python tools/embed_dataset.py --root ../benchmark-data/lfw_funneled --report-only
    python tools/embed_dataset.py --root ../benchmark-data/lfw_funneled \
        --out ../benchmark-data/gallery.jsonl --identities 2000
"""

import argparse
import json
import random
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import preprocessing  # noqa: E402
import recognition  # noqa: E402
from config import settings  # noqa: E402

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".ppm"}


@dataclass
class Extracted:
    """One image that produced a usable embedding."""

    path: Path
    embedding: np.ndarray
    sharpness: float
    brightness: float
    det_score: float
    face_height_ratio: float


def find_identities(root: Path, min_images: int) -> list[tuple[str, list[Path]]]:
    """Every person directory holding at least `min_images` images, sorted by name.

    Sorted rather than walked in filesystem order so two runs over the same
    directory pick the same identities. A benchmark that quietly changes its own
    population between runs cannot be compared against itself.
    """
    identities = []

    for person_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        images = sorted(
            p for p in person_dir.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES
        )
        if len(images) >= min_images:
            identities.append((person_dir.name, images))

    return identities


def _pick_subject_face(faces: list, shape: tuple):
    """Choose which detected face is the labelled subject.

    Scored on area and closeness to the frame centre together, because neither
    alone is right: a large face at the edge is usually a bystander who happened
    to be nearer the camera, and a small central face is usually background.
    Multiplying the two picks the person the photograph is of.
    """
    if not faces:
        return None
    if len(faces) == 1:
        return faces[0]

    height, width = shape[:2]
    cx, cy = width / 2.0, height / 2.0
    diagonal = float(np.hypot(width, height))

    def score(face) -> float:
        x1, y1, x2, y2 = face.bbox
        area = max(x2 - x1, 0) * max(y2 - y1, 0)
        fx, fy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        offset = float(np.hypot(fx - cx, fy - cy)) / diagonal
        return area * (1.0 - min(offset, 1.0))

    return max(faces, key=score)


def extract(path: Path, min_sharpness: float) -> tuple[Extracted | None, str]:
    """Embed one image, or say why it could not be embedded."""
    image = preprocessing.decode_image(path.read_bytes())
    if image is None:
        return None, "undecodable_image"

    sharpness = preprocessing.measure_sharpness(image)
    brightness = preprocessing.measure_brightness(image)

    if sharpness < min_sharpness:
        return None, "frame_too_blurry"
    if brightness < 25.0:
        return None, "frame_too_dark"
    if brightness > 235.0:
        return None, "frame_overexposed"

    normalised = preprocessing.normalize_lighting(image)
    faces = recognition.detect_faces(normalised)

    face = _pick_subject_face(faces, normalised.shape)
    if face is None:
        return None, "no_face_detected"

    if face.det_score < settings.det_score_threshold:
        return None, "low_detection_confidence"

    ratio = face.height / normalised.shape[0]
    if ratio < settings.min_face_height_ratio:
        return None, "face_too_small"

    return (
        Extracted(
            path=path,
            embedding=face.embedding,
            sharpness=sharpness,
            brightness=brightness,
            det_score=face.det_score,
            face_height_ratio=ratio,
        ),
        "ok",
    )


def summarise(values: list[float]) -> dict:
    """Percentiles, not just a mean. The tail is the part that matters here."""
    if not values:
        return {}
    ordered = sorted(values)

    def pct(p: float) -> float:
        return round(ordered[min(int(p * len(ordered)), len(ordered) - 1)], 3)

    return {
        "n": len(ordered),
        "min": round(ordered[0], 3),
        "p05": pct(0.05),
        "p25": pct(0.25),
        "median": round(statistics.median(ordered), 3),
        "p75": pct(0.75),
        "p95": pct(0.95),
        "max": round(ordered[-1], 3),
    }


def report(identities: list, sample_size: int) -> int:
    """Measure the dataset without writing anything, so thresholds can be chosen."""
    sample = identities[:sample_size]
    print(f"\nreport-only: measuring {len(sample)} identities, first image each\n")
    recognition.warm_up()

    sharpness_values: list[float] = []
    ratios: list[float] = []
    outcomes: dict[str, int] = {}

    for _name, images in sample:
        image = preprocessing.decode_image(images[0].read_bytes())
        if image is None:
            outcomes["undecodable_image"] = outcomes.get("undecodable_image", 0) + 1
            continue
        sharpness_values.append(preprocessing.measure_sharpness(image))

        # Measured with the sharpness gate off, so this says how many images the
        # detector can use. Whether to also apply a sharpness floor is then a
        # separate decision, made from the distribution printed above it.
        found, reason = extract(images[0], 0.0)
        outcomes[reason] = outcomes.get(reason, 0) + 1
        if found:
            ratios.append(found.face_height_ratio)

    print("sharpness (Laplacian variance)")
    for key, value in summarise(sharpness_values).items():
        print(f"  {key:8} {value}")
    below = sum(1 for s in sharpness_values if s < settings.min_sharpness)
    print(f"\n  the live gate is min_sharpness = {settings.min_sharpness}")
    print(
        f"  {below}/{len(sharpness_values)} "
        f"({below / max(len(sharpness_values), 1):.1%}) of these fall below it"
    )

    print("\nface height as a fraction of image height")
    for key, value in summarise(ratios).items():
        print(f"  {key:8} {value}")
    print(f"\n  the live gate is min_face_height_ratio = {settings.min_face_height_ratio}")

    print("\ndetection outcome, sharpness gate disabled")
    for reason, count in sorted(outcomes.items(), key=lambda kv: -kv[1]):
        print(f"  {reason:26} {count:5}  {count / len(sample):.1%}")

    return 0


def run(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 1

    identities = find_identities(root, args.min_images)
    if not identities:
        print(f"no identity directories with >= {args.min_images} images under {root}")
        return 1

    print(f"{len(identities)} identities with >= {args.min_images} images in {root}")

    # Sampled rather than taking the alphabetical head, so the gallery is not
    # skewed toward whatever the names happen to sort to. Seeded so the same
    # population comes back on a re-run.
    rng = random.Random(args.seed)
    if args.identities and args.identities < len(identities):
        identities = rng.sample(identities, args.identities)
        identities.sort(key=lambda pair: pair[0])
        print(f"sampled {len(identities)} of them (seed {args.seed})")

    if args.report_only:
        return report(identities, args.report_sample)

    if not args.out:
        print("--out is required unless --report-only is given", file=sys.stderr)
        return 1

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"min_sharpness for this run: {args.min_sharpness}")
    print("loading models...")
    recognition.warm_up()

    written = 0
    skipped = 0
    probe_count = 0
    rejections: dict[str, int] = {}
    agreements: list[float] = []

    with out_path.open("w", encoding="utf-8") as handle:
        for index, (name, images) in enumerate(identities, start=1):
            usable: list[Extracted] = []

            for image_path in images[: args.enroll_images + args.probe_images]:
                found, reason = extract(image_path, args.min_sharpness)
                if found is None:
                    rejections[reason] = rejections.get(reason, 0) + 1
                    continue
                usable.append(found)

            if len(usable) < args.enroll_images:
                skipped += 1
                continue

            enrol = usable[: args.enroll_images]
            probes = usable[args.enroll_images :]

            fused, per_sample = recognition.build_enrollment_embedding(
                [e.embedding for e in enrol]
            )
            mean_similarity = round(float(np.mean(per_sample)), 4)
            agreements.append(mean_similarity)

            handle.write(
                json.dumps(
                    {
                        "label": name,
                        "embedding_b64": recognition.encode_embedding(fused),
                        "enrollment": {
                            "samplesUsed": len(enrol),
                            "meanSimilarity": mean_similarity,
                            "outliersDropped": 0,
                        },
                        "quality": {
                            "sharpness": round(
                                float(np.mean([e.sharpness for e in enrol])), 2
                            ),
                            "detScore": round(
                                float(np.mean([e.det_score for e in enrol])), 4
                            ),
                        },
                        "probes": [
                            {
                                "image": str(p.path.relative_to(root)).replace(
                                    "\\", "/"
                                ),
                                "embedding_b64": recognition.encode_embedding(
                                    p.embedding
                                ),
                            }
                            for p in probes
                        ],
                    }
                )
                + "\n"
            )
            written += 1
            probe_count += len(probes)

            if index % 250 == 0:
                print(f"  {index}/{len(identities)}  written={written} skipped={skipped}")

    print(f"\nwrote {written} identities and {probe_count} held-out probes to {out_path}")
    print(f"skipped {skipped} identities with too few usable images")

    # Only meaningful when several samples were fused. With one, every sample
    # agrees with itself perfectly and the figure is 1.0 by construction --
    # printing it would look like a quality result and mean nothing at all.
    if agreements and args.enroll_images > 1:
        print("\nenrollment agreement across the fused samples")
        for key, value in summarise(agreements).items():
            print(f"  {key:8} {value}")

    if rejections:
        total = sum(rejections.values())
        print(f"\nrejected {total} images")
        for reason, count in sorted(rejections.items(), key=lambda kv: -kv[1]):
            print(f"  {reason:26} {count:6}  {count / total:.1%}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--root", required=True, help="directory of per-person folders")
    parser.add_argument("--out", help="JSONL file to write")
    parser.add_argument(
        "--identities",
        type=int,
        default=0,
        help="cap on how many identities to use (0 = all)",
    )
    parser.add_argument(
        "--min-images",
        type=int,
        default=1,
        help="ignore people with fewer images than this",
    )
    parser.add_argument(
        "--enroll-images",
        type=int,
        default=1,
        help="images fused into the stored gallery vector",
    )
    parser.add_argument(
        "--probe-images",
        type=int,
        default=0,
        help="further images held out as genuine probes",
    )
    parser.add_argument(
        "--min-sharpness",
        type=float,
        default=settings.min_sharpness,
        help="Laplacian variance floor; see the note at the top of this file",
    )
    parser.add_argument("--seed", type=int, default=20260822)
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="measure the dataset and print distributions without writing anything",
    )
    parser.add_argument("--report-sample", type=int, default=300)

    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
