"""MiniVision's silent anti-spoofing models, wrapped and measured.

What this is
------------
Two small MiniFASNets from minivision-ai/Silent-Face-Anti-Spoofing, Apache-2.0,
converted to ONNX. Together they are 3.4MB and run on the ONNX Runtime this
service already loads for ArcFace, so nothing new is installed and no training
data has to be collected.

They answer the question the two hand-built passive checks could not. Both of
those measured *geometry* -- where landmarks sit -- and both drowned in the
landmark noise of a moving image. These look at the pixels instead: ink on
paper, a display's pixel grid, light scattered under real skin.

Three classes, not two, whatever the ONNX port's README says. The graph outputs
three and the reference implementation reads them as:

    0  paper photo
    1  real face
    2  screen photo

which is more useful than a bare real/fake, because knowing *which* attack was
presented is what tells a shopkeeper what to say.

Preprocessing is exact or it is worthless
-----------------------------------------
The numbers in the filenames are bounding-box expansion factors: 2.7 for
MiniFASNetV2, 4.0 for MiniFASNetV1SE. Each model was trained on a crop of that
size around the face and expects the same at inference. Get it wrong and the
model still returns confident answers that mean nothing.

Two details that are easy to get backwards, both taken from the reference
implementation rather than guessed:

*   The input stays **BGR**. The models were trained on frames straight out of
    cv2.imread, so converting to RGB silently swaps two channels of a model
    whose whole signal is colour.
*   Pixels stay in **0-255**. There is no division by 255 and no mean/std
    normalisation.

The two models' softmax outputs are summed, not averaged or voted -- again as
the reference does.

    python tools/silent_pad.py --samples ../benchmark-data/pad-models/sample
    python tools/silent_pad.py --lfw ../benchmark-data/lfw_funneled --limit 100
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import preprocessing  # noqa: E402
import recognition  # noqa: E402

MODEL_DIR = Path(__file__).resolve().parents[2] / "benchmark-data" / "pad-models"
MODELS = {
    "2.7_80x80_MiniFASNetV2.onnx": 2.7,
    "4_0_0_80x80_MiniFASNetV1SE.onnx": 4.0,
}
LABELS = ("paper photo", "real face", "screen photo")
INPUT = (80, 80)

_sessions: list[tuple[object, float]] = []


def _load():
    global _sessions
    if _sessions:
        return _sessions

    import onnxruntime as ort

    for name, scale in MODELS.items():
        path = MODEL_DIR / name
        if not path.is_file():
            raise FileNotFoundError(f"missing {path}")
        _sessions.append(
            (ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]), scale)
        )
    return _sessions


def expand_box(width: int, height: int, box, scale: float):
    """The reference crop, reproduced exactly.

    Note the boundary handling: when the expanded box runs off an edge it is
    *shifted back in* rather than clipped, so the crop keeps its size and the
    face keeps its scale within it. Clipping instead would hand the model a
    differently-scaled face near frame edges, which is where a held photograph
    tends to sit.
    """
    x, y, box_w, box_h = box
    scale = min((height - 1) / box_h, min((width - 1) / box_w, scale))

    new_w, new_h = box_w * scale, box_h * scale
    cx, cy = box_w / 2 + x, box_h / 2 + y

    left, top = cx - new_w / 2, cy - new_h / 2
    right, bottom = cx + new_w / 2, cy + new_h / 2

    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > width - 1:
        left -= right - width + 1
        right = width - 1
    if bottom > height - 1:
        top -= bottom - height + 1
        bottom = height - 1

    return int(left), int(top), int(right), int(bottom)


def predict(bgr: np.ndarray, box) -> dict:
    """Ensemble both models over one face box. `box` is (x, y, w, h)."""
    height, width = bgr.shape[:2]
    total = np.zeros(3, dtype=np.float64)

    for session, scale in _load():
        left, top, right, bottom = expand_box(width, height, box, scale)
        crop = bgr[top : bottom + 1, left : right + 1]
        if crop.size == 0:
            continue

        resized = cv2.resize(crop, INPUT).astype(np.float32)  # BGR, 0-255
        batch = np.expand_dims(np.transpose(resized, (2, 0, 1)), 0)

        logits = session.run(None, {session.get_inputs()[0].name: batch})[0]
        exp = np.exp(logits - logits.max(axis=1, keepdims=True))
        total += (exp / exp.sum(axis=1, keepdims=True))[0]

    scores = total / max(len(_load()), 1)
    label = int(np.argmax(scores))
    return {
        "label": label,
        "label_text": LABELS[label],
        "is_real": label == 1,
        "real_score": float(scores[1]),
        "scores": [round(float(s), 4) for s in scores],
    }


def face_box(bgr: np.ndarray):
    """Largest detected face as (x, y, w, h), using the service's own detector."""
    faces = recognition.detect_faces(bgr)
    if not faces:
        return None
    face = max(faces, key=lambda f: f.bbox_area)
    x1, y1, x2, y2 = face.bbox
    return (x1, y1, x2 - x1, y2 - y1)


def run_samples(folder: Path) -> int:
    """The repo's own labelled images: T = real, F = attack.

    Run first and always. If these do not come out right the preprocessing is
    wrong, and every number measured afterwards would be measuring that mistake
    rather than the model.
    """
    images = sorted(folder.glob("image_*"))
    if not images:
        print(f"no samples in {folder}", file=sys.stderr)
        return 1

    correct = 0
    for path in images:
        image = preprocessing.decode_image(path.read_bytes())
        if image is None:
            continue
        box = face_box(image)
        if box is None:
            print(f"  {path.name:16} no face found")
            continue

        result = predict(image, box)
        expected_real = path.stem.split("_")[1].startswith("T")
        ok = result["is_real"] == expected_real
        correct += ok
        print(
            f"  {path.name:16} {'REAL ' if expected_real else 'ATTACK'} -> "
            f"{result['label_text']:13} real={result['real_score']:.3f}  "
            f"{'ok' if ok else 'WRONG'}"
        )

    print(f"\n{correct}/{len(images)} of the reference samples classified correctly")
    return 0 if correct == len(images) else 1


def run_lfw(root: Path, limit: int) -> int:
    """Real people, photographed by real cameras, from a dataset this model never saw.

    The question is false rejection across a domain shift. These are press
    photographs, nothing like whatever MiniVision trained on, and every one of
    them is a genuine camera capture of a living person -- so anything called an
    attack here is a customer who would have been turned away.
    """
    people = [p for p in sorted(root.iterdir()) if p.is_dir()]
    real, rejected, missed = 0, [], 0
    scores = []

    for person in people:
        if real >= limit:
            break
        shots = sorted(person.glob("*.jpg"))
        if not shots:
            continue

        image = preprocessing.decode_image(shots[0].read_bytes())
        if image is None:
            continue
        box = face_box(image)
        if box is None:
            missed += 1
            continue

        result = predict(image, box)
        scores.append(result["real_score"])
        real += 1
        if not result["is_real"]:
            rejected.append((person.name, result["label_text"], result["real_score"]))

    scores.sort()
    print(f"\n{real} live captures of real people, {missed} with no face found\n")
    print(f"  real-class score   min {scores[0]:.3f}   median {scores[len(scores)//2]:.3f}   max {scores[-1]:.3f}")
    print(f"  called an attack   {len(rejected)}/{real}  ({len(rejected)/real:.1%})")

    for name, text, score in rejected[:12]:
        print(f"     {name:28} {text:13} real={score:.3f}")

    print("\n" + "=" * 64)
    if len(rejected) / real <= 0.05:
        print("Holds up across a domain it was never trained on. That is the")
        print("property the hand-built checks lacked, and the reason a model")
        print("trained on a large varied dataset is worth more here than one")
        print("fitted to a single room.")
    else:
        print("Rejects too many genuine captures on unseen data. Usable only")
        print("with a threshold tuned on this camera, not as shipped.")
    return 0


def run_captured(root: Path) -> int:
    """Score the model against a set captured by collect_pad.py.

    This is the measurement that decides anything. LFW says how it behaves on
    press photographs; only frames from the camera it will actually run on say
    how it behaves in the shop. Reported per label, and per device, because a
    figure averaged over two cameras hides the one that does not work.
    """
    import json
    from collections import defaultdict

    index = root / "index.jsonl"
    if not index.is_file():
        print(f"no index at {index} -- run collect_pad.py first", file=sys.stderr)
        return 1

    rows = [json.loads(l) for l in index.read_text(encoding="utf-8").splitlines() if l.strip()]
    buckets = defaultdict(list)

    for row in rows:
        image = cv2.imread(str(root / row["file"]))
        if image is None:
            continue
        box = face_box(image)
        if box is None:
            continue
        result = predict(image, box)
        key = (row.get("device", "unlabelled"), row["label"])
        buckets[key].append(result["real_score"])

    if not buckets:
        print("nothing scorable", file=sys.stderr)
        return 1

    header = f"{'device':<18} {'label':<8} {'n':>5} {'median real':>12} {'p05':>7} {'p95':>7}"
    print()
    print(header)
    for (device, label), scores in sorted(buckets.items()):
        scores.sort()
        median = scores[len(scores) // 2]
        p05 = scores[max(int(0.05 * len(scores)) - 1, 0)]
        p95 = scores[min(int(0.95 * len(scores)), len(scores) - 1)]
        print(f"{device:<18} {label:<8} {len(scores):>5} {median:>12.3f} {p05:>7.3f} {p95:>7.3f}")

    # The threshold is on the real-class score, not on argmax. Argmax is what
    # the reference does and it is the weaker reading: on the repo's own
    # samples a held printout scored 0.728 real, which argmax calls real and a
    # threshold catches.
    print()
    print(f"{'threshold':>10} {'real refused':>14} {'attacks through':>17}")
    for t in (0.5, 0.7, 0.8, 0.9, 0.95, 0.99):
        real = [s for (d, l), v in buckets.items() if l == "real" for s in v]
        attack = [s for (d, l), v in buckets.items() if l != "real" for s in v]
        if not real or not attack:
            print("  need both real and attack samples for this table")
            break
        frr = sum(1 for s in real if s < t) / len(real)
        far = sum(1 for s in attack if s >= t) / len(attack)
        print(f"{t:>10.2f} {frr:>13.1%} {far:>16.1%}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--samples", help="the repo's labelled sample folder")
    parser.add_argument("--lfw", help="LFW root, to measure false rejection")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--data", help="a set captured by collect_pad.py")
    args = parser.parse_args()

    recognition.warm_up()

    if args.samples:
        code = run_samples(Path(args.samples).resolve())
        if code:
            return code
    if args.lfw:
        code = run_lfw(Path(args.lfw).resolve(), args.limit)
        if code:
            return code
    if args.data:
        return run_captured(Path(args.data).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
