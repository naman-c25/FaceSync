"""Train and honestly evaluate a presentation-attack detector.

The features
------------
Local binary patterns on the *chroma* channels, not on brightness. That choice
is the whole method rather than a detail: greyscale texture separates print and
replay from skin poorly, while the same operator over HSV and YCbCr separates
them well, because a printer and a screen reproduce colour differently from
skin. Skin scatters light beneath its surface; ink sits on paper and a display
emits from a pixel grid, and both get the hue subtly wrong in ways that survive
resizing and compression.

Sixty numbers per face, computed in milliseconds on a CPU, with no model to
download and nothing to explain away later. Every one of them can be pointed at
and described, which a convolutional network's answer cannot.

The evaluation
--------------
Grouped, never random. A random split puts frames of the same person in both
train and test, and since consecutive frames of one capture are nearly
identical, the score that comes back is a measure of how well the model
memorised that person -- routinely 99% and completely meaningless.

So two protocols run, and the second is the one that matters:

  leave-one-person-out     can it judge a face it has never seen?
  leave-one-condition-out  can it judge a light it was not trained in?

The second is where self-collected sets fall apart. If real and spoof samples
were captured in different lighting, a classifier learns the lighting, scores
brilliantly by person, and collapses by condition. That gap is the honest
measure of whether this transfers or has simply memorised the room.

    python tools/train_pad.py --data ../benchmark-data/pad
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from skimage.feature import local_binary_pattern
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

CROP = 128
LBP_POINTS = 8
LBP_RADIUS = 1
BINS = LBP_POINTS + 2  # uniform patterns


def features(image: np.ndarray) -> np.ndarray:
    """Chroma-texture descriptor for one face crop."""
    face = cv2.resize(image, (CROP, CROP), interpolation=cv2.INTER_AREA)

    histograms = []
    for space in (
        cv2.cvtColor(face, cv2.COLOR_BGR2YCrCb),
        cv2.cvtColor(face, cv2.COLOR_BGR2HSV),
    ):
        for channel in range(3):
            lbp = local_binary_pattern(
                space[:, :, channel], P=LBP_POINTS, R=LBP_RADIUS, method="uniform"
            )
            hist, _ = np.histogram(lbp, bins=BINS, range=(0, BINS), density=True)
            histograms.append(hist)

    return np.concatenate(histograms).astype(np.float32)


def load(root: Path):
    index = root / "index.jsonl"
    if not index.is_file():
        print(f"no index at {index} -- run collect_pad.py first", file=sys.stderr)
        return None

    rows = [json.loads(line) for line in index.read_text(encoding="utf-8").splitlines() if line.strip()]
    print(f"{len(rows)} captured crops")
    print(Counter(r["label"] for r in rows))
    print(Counter(r["person"] for r in rows))
    print(Counter(r["condition"] for r in rows))

    X, y, people, conditions = [], [], [], []
    for row in rows:
        image = cv2.imread(str(root / row["file"]))
        if image is None:
            continue
        X.append(features(image))
        # Everything that is not a live face is an attack, whatever kind.
        y.append(0 if row["label"] == "real" else 1)
        people.append(row["person"])
        conditions.append(row["condition"])

    return np.stack(X), np.asarray(y), np.asarray(people), np.asarray(conditions)


def model() -> object:
    # RBF SVM over sixty standardised histogram bins. Small enough that this
    # trains in seconds and cannot quietly memorise a set this size.
    return make_pipeline(StandardScaler(), SVC(kernel="rbf", C=10.0, gamma="scale", probability=True))


def protocol(name: str, X, y, groups) -> dict | None:
    unique = np.unique(groups)
    if len(unique) < 2:
        print(f"\n{name}: needs at least two groups, found {len(unique)}")
        return None

    splitter = LeaveOneGroupOut()
    scores, truths, held = [], [], []

    for train_idx, test_idx in splitter.split(X, y, groups):
        if len(np.unique(y[train_idx])) < 2 or len(np.unique(y[test_idx])) < 2:
            continue
        clf = model().fit(X[train_idx], y[train_idx])
        scores.append(clf.predict_proba(X[test_idx])[:, 1])
        truths.append(y[test_idx])
        held.append(groups[test_idx][0])

    if not scores:
        print(f"\n{name}: no fold had both classes on both sides")
        return None

    scores = np.concatenate(scores)
    truths = np.concatenate(truths)

    # Equal error rate: the threshold where the two mistakes cost the same. It
    # does not depend on where an operating point is later placed, so it is the
    # right single number for asking whether the signal is there at all.
    best = (1.0, 1.0, 0.0)
    for t in np.linspace(0, 1, 501):
        far = float(np.mean(scores[truths == 1] < t))   # attacks let through
        frr = float(np.mean(scores[truths == 0] >= t))  # real faces refused
        if abs(far - frr) < best[0]:
            best = (abs(far - frr), (far + frr) / 2, t)

    auc = roc_auc_score(truths, scores)
    print(f"\n{name}   ({len(held)} folds: {', '.join(map(str, held))})")
    print(f"  AUC   {auc:.4f}")
    print(f"  EER   {best[1]:.2%}   at threshold {best[2]:.3f}")

    print(f"\n  {'threshold':>10} {'attacks through':>17} {'real refused':>14}")
    for t in (0.3, 0.4, 0.5, 0.6, 0.7):
        far = float(np.mean(scores[truths == 1] < t))
        frr = float(np.mean(scores[truths == 0] >= t))
        print(f"  {t:>10.2f} {far:>16.1%} {frr:>13.1%}")

    return {"auc": float(auc), "eer": best[1]}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--data", default="../benchmark-data/pad")
    args = parser.parse_args()

    loaded = load(Path(args.data).resolve())
    if loaded is None:
        return 1
    X, y, people, conditions = loaded

    if len(np.unique(y)) < 2:
        print("\nonly one class captured -- both real and attack samples are needed")
        return 1

    by_person = protocol("LEAVE ONE PERSON OUT", X, y, people)
    by_condition = protocol("LEAVE ONE CONDITION OUT", X, y, conditions)

    print("\n" + "=" * 64)
    if not by_person:
        return 1

    if by_condition and by_condition["eer"] > by_person["eer"] + 0.10:
        print("MEMORISED THE ROOM. It judges unseen faces far better than unseen")
        print(f"lighting -- {by_person['eer']:.1%} by person against")
        print(f"{by_condition['eer']:.1%} by condition. That gap is the model")
        print("keying on capture conditions rather than on the attack, which is")
        print("what happens when real and spoof samples are not collected side")
        print("by side in the same light. Recapture before trusting any of it.")
    elif by_person["eer"] <= 0.05:
        print(f"USABLE on this camera. {by_person['eer']:.1%} equal error rate on")
        print("faces it has never seen, and it holds across lighting.")
        print("\nSay plainly what it is: validated on one camera in the")
        print("conditions it was captured in. It is not a claim about other")
        print("cameras, and published cross-dataset results are an order of")
        print("magnitude worse than within-dataset ones for exactly this reason.")
    else:
        print(f"TOO WEAK. {by_person['eer']:.1%} equal error rate is not a gate a")
        print("payment can rest on. More data and more varied conditions before")
        print("anything else -- or accept that the active challenge is what")
        print("stops a photograph here.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
