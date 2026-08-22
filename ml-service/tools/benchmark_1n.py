"""Measure 1:N identification against a large gallery.

The question
------------
Every accuracy number this project has quoted so far came from a gallery of a
handful of people. That is not evidence. A 1:N system compares the face in front
of it against every enrolled identity, so each extra enrollment is another
chance to be confused with someone else, and the false match rate of the system
grows roughly as N x the rate of a single comparison. "No false matches against
seven other people" and "no false matches against two thousand" are different
claims, and only the second one is worth making.

This script answers the second one, using the same `recognition.identify` the
service runs, against a gallery built by `embed_dataset.py`.

Four measurements
-----------------
1.  All-pairs impostor scores across the gallery. Every pair of rows is a
    different person, so every score is an impostor score. At N=2000 that is
    about two million comparisons, which is enough to see the tail rather than
    guess at it. The tail is the whole story: the mean impostor score is
    irrelevant, and the maximum is what decides whether a threshold is safe.

2.  Genuine scores, from held-out images. A second photograph of the same person
    taken on a different day, never folded into the stored vector.

3.  Closed-set identification. Each held-out probe is run through the real
    two-condition rule against the full gallery. Reported as correct match,
    wrong match, ambiguous, and no match -- with wrong match being the one that
    matters, since that is a payment taken from the wrong person.

4.  Open-set identification. Probes from identities deliberately kept out of the
    gallery. This is the case a payment kiosk actually faces most often: someone
    who is not enrolled walks up, and every one of them must be rejected. A
    system tuned only on closed-set accuracy will happily match them to the
    nearest stranger.

A note on the sweep
-------------------
The threshold sweep is vectorised rather than calling `identify` per probe per
threshold, which would be minutes of redundant matrix multiplication. Because a
fast reimplementation of the decision rule is exactly the kind of thing that
drifts from the original, the sweep is checked against real `identify` calls on
a subset before any of its numbers are printed. If they ever disagree the script
says so and stops, rather than reporting figures from a rule the service does
not use.

Usage
-----
    python tools/benchmark_1n.py --gallery ../benchmark-data/gallery.jsonl
    python tools/benchmark_1n.py --gallery ../benchmark-data/gallery.jsonl \
        --holdout 300 --json ../benchmark-data/results.json
"""

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import recognition  # noqa: E402
from config import settings  # noqa: E402
from recognition import GalleryEntry, MatchDecision  # noqa: E402


def load(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def as_matrix(rows: list[dict], key: str = "embedding_b64") -> np.ndarray:
    return np.stack([recognition.decode_embedding(r[key]) for r in rows])


def distribution(scores: np.ndarray, name: str) -> dict:
    """Percentiles of a score distribution, with the upper tail spelled out."""
    if scores.size == 0:
        return {}

    quantiles = [0.0, 0.5, 0.9, 0.99, 0.999, 0.9999, 1.0]
    values = np.quantile(scores, quantiles)

    print(f"\n{name}  (n = {scores.size:,})")
    print(f"  mean      {scores.mean():.4f}")
    print(f"  std       {scores.std():.4f}")
    for q, v in zip(quantiles, values):
        label = "min" if q == 0 else "max" if q == 1 else f"p{q * 100:g}"
        print(f"  {label:9} {v:.4f}")

    return {
        "n": int(scores.size),
        "mean": round(float(scores.mean()), 4),
        "std": round(float(scores.std()), 4),
        **{
            ("min" if q == 0 else "max" if q == 1 else f"p{q * 100:g}"): round(
                float(v), 4
            )
            for q, v in zip(quantiles, values)
        },
    }


def all_pairs_impostor(matrix: np.ndarray, chunk: int = 512) -> np.ndarray:
    """Every cross-identity similarity in the gallery.

    Computed in row blocks. The full N x N matrix at N=2000 is only 16MB, but
    this is the measurement that most wants to be run at N=50,000 later, where
    it would be 10GB -- and a benchmark that has to be rewritten to answer the
    bigger question is not much of a benchmark.
    """
    n = matrix.shape[0]
    pieces = []

    for start in range(0, n, chunk):
        stop = min(start + chunk, n)
        block = matrix[start:stop] @ matrix.T

        # Keep the strict upper triangle only: the diagonal is each row against
        # itself, and the lower half is the same pairs a second time. Including
        # either would drag the reported distribution toward a number that no
        # real comparison ever produces.
        rows = np.arange(start, stop)[:, None]
        cols = np.arange(n)[None, :]
        pieces.append(block[cols > rows])

    return np.concatenate(pieces) if pieces else np.empty(0, dtype=np.float32)


def find_label_errors(
    matrix: np.ndarray, labels: list[str], threshold: float
) -> list[tuple[int, int, float]]:
    """Pairs of supposedly different identities that are almost certainly one person.

    Public face datasets contain labelling mistakes, and LFW is no exception: the
    first run of this script turned up Andrew_Caldecott and Andrew_Gilligan at
    0.956, which on inspection are the same photograph filed under two names.

    Leaving that in would be reporting a cataloguing error as a false match, and
    it poisons the numbers in both directions -- it puts a near-1.0 score in the
    impostor distribution, and it makes the closed-set test count a correct
    identification as a wrong one, since the probe of one label matches the row
    of the other.

    Taking them out silently would be worse. So they are found, printed by name,
    and the impostor distribution is reported both ways.

    The threshold is high on purpose. A pair of genuinely different people
    scoring above it would have to match each other better than most people
    match their own second photograph, which says the labels are wrong far more
    often than it says the model is.
    """
    n = matrix.shape[0]
    found = []

    for start in range(0, n, 512):
        stop = min(start + 512, n)
        block = matrix[start:stop] @ matrix.T
        rows = np.arange(start, stop)[:, None]
        cols = np.arange(n)[None, :]
        hits = np.argwhere((block >= threshold) & (cols > rows))

        for local_row, col in hits:
            found.append((start + int(local_row), int(col), float(block[local_row, col])))

    return sorted(found, key=lambda t: -t[2])


def collapse_duplicates(pairs: list[tuple[int, int, float]]) -> set[int]:
    """Indices to drop so each group of same-person labels appears once.

    Union-find over the flagged pairs, keeping the lowest index in each group.
    A group rather than a pair because a person filed under three names would
    otherwise leave two of them still colliding.
    """
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, j, _ in pairs:
        a, b = find(i), find(j)
        if a != b:
            parent[max(a, b)] = min(a, b)

    return {x for x in parent if find(x) != x}


def find_probe_mislabels(
    scores: np.ndarray, truth: np.ndarray, self_below: float, match_threshold: float
) -> np.ndarray:
    """Probes that are not the person whose folder they were filed in.

    The other half of the dataset's label noise, and the more damaging half.
    `find_label_errors` catches one person filed under two names; this catches
    one name holding two people -- a folder where the second photograph is of
    somebody else entirely. LFW is full of these because press photographs come
    in pairs: Kate Capshaw's second image is Steven Spielberg, Don Nickles' is
    Charles Grassley, and both were filed by who the caption was about rather
    than by who is in the crop.

    Counting those as wrong-person matches would be reporting a cataloguing
    error as a payment taken from the wrong account, which is the single most
    serious number this script produces and must not be inflated by noise.

    Two conditions, and the second one is what makes this safe to automate:

    1.  The probe barely matches its own enrolled row. On its own this is not
        evidence of anything -- a genuine photograph in bad light or hard pose
        scores low too, and those are real false rejections that belong in the
        results.

    2.  ...while matching some *other* enrolled identity above the threshold.
        A photograph cannot be a poor likeness of the person it is of and a good
        likeness of somebody else at the same time. When both hold, the label is
        wrong, not the model.

    A genuinely hard image fails only the first test and is left in.
    """
    self_scores = scores[np.arange(scores.shape[0]), truth]

    # The best score against anything that is not the probe's own row.
    masked = scores.copy()
    masked[np.arange(scores.shape[0]), truth] = -np.inf
    best_other = masked.max(axis=1)

    return np.where((self_scores < self_below) & (best_other >= match_threshold))[0]


def decide(
    scores: np.ndarray, threshold: float, margin: float
) -> tuple[np.ndarray, np.ndarray]:
    """The two-condition rule, applied to many probes at once.

    Returns the index of the winning gallery row per probe and a code:
    0 matched, 1 no_match, 2 ambiguous. Checked against `recognition.identify`
    by `verify_agreement` before any result derived from it is reported.
    """
    # argpartition rather than a full sort: only the top two matter, and at
    # N=2000 per probe the difference is real.
    top2 = np.argpartition(-scores, 1, axis=1)[:, :2]
    top2_scores = np.take_along_axis(scores, top2, axis=1)

    order = np.argsort(-top2_scores, axis=1)
    top2 = np.take_along_axis(top2, order, axis=1)
    top2_scores = np.take_along_axis(top2_scores, order, axis=1)

    best_index = top2[:, 0]
    best = top2_scores[:, 0]
    runner_up = top2_scores[:, 1]

    code = np.zeros(scores.shape[0], dtype=np.int8)
    code[best < threshold] = 1
    code[(best >= threshold) & ((best - runner_up) < margin)] = 2

    return best_index, code


def verify_agreement(
    probes: np.ndarray, gallery: list[GalleryEntry], matrix: np.ndarray, sample: int
) -> bool:
    """Confirm the vectorised rule matches the one the service actually runs."""
    if probes.shape[0] == 0:
        return True

    count = min(sample, probes.shape[0])
    indices = np.linspace(0, probes.shape[0] - 1, count).astype(int)

    fast_index, fast_code = decide(
        probes[indices] @ matrix.T, settings.match_threshold, settings.match_margin
    )
    expected = {
        MatchDecision.MATCHED: 0,
        MatchDecision.NO_MATCH: 1,
        MatchDecision.AMBIGUOUS: 2,
    }

    for position, probe_index in enumerate(indices):
        real = recognition.identify(probes[probe_index], gallery)

        if expected[real.decision] != fast_code[position]:
            print(
                f"\nDISAGREEMENT on probe {probe_index}: identify() said "
                f"{real.decision.value}, the vectorised rule said "
                f"{['matched', 'no_match', 'ambiguous'][fast_code[position]]}",
                file=sys.stderr,
            )
            return False

        if real.decision is MatchDecision.MATCHED:
            if real.user_id != gallery[fast_index[position]].user_id:
                print(
                    f"\nDISAGREEMENT on probe {probe_index}: identify() chose "
                    f"{real.user_id}, the vectorised rule chose "
                    f"{gallery[fast_index[position]].user_id}",
                    file=sys.stderr,
                )
                return False

    print(f"vectorised rule agrees with identify() on {count} probes")
    return True


def closed_set(
    scores: np.ndarray, truth: np.ndarray, threshold: float, margin: float
) -> dict:
    """Identification outcomes for probes whose identity IS in the gallery."""
    best, code = decide(scores, threshold, margin)
    total = scores.shape[0]
    if total == 0:
        return {}

    matched = code == 0
    correct = matched & (best == truth)
    wrong = matched & (best != truth)

    return {
        "probes": total,
        "correct": int(correct.sum()),
        "wrong": int(wrong.sum()),
        "ambiguous": int((code == 2).sum()),
        "no_match": int((code == 1).sum()),
        "correct_rate": round(float(correct.sum() / total), 4),
        # A payment taken from the wrong person. The only number here that
        # represents money moving out of an account that did not authorise it.
        "wrong_rate": round(float(wrong.sum() / total), 6),
        "reject_rate": round(float(((code == 1) | (code == 2)).sum() / total), 4),
    }


def open_set(scores: np.ndarray, threshold: float, margin: float) -> dict:
    """Outcomes for probes whose identity is NOT in the gallery at all.

    Every one of these should be refused. Anything matched is a stranger being
    charged as a customer, which is the failure mode a kiosk faces every time
    someone who has never enrolled walks up to it.
    """
    _, code = decide(scores, threshold, margin)
    total = scores.shape[0]
    if total == 0:
        return {}

    return {
        "probes": total,
        "false_matches": int((code == 0).sum()),
        "ambiguous": int((code == 2).sum()),
        "rejected": int((code == 1).sum()),
        "false_match_rate": round(float((code == 0).sum() / total), 6),
    }


def sweep(
    closed_scores: np.ndarray,
    truth: np.ndarray,
    open_scores: np.ndarray,
    thresholds: list[float],
    margins: list[float],
) -> list[dict]:
    print(
        f"\n{'thr':>6} {'margin':>7} | {'correct':>8} {'wrong':>7} {'reject':>7}"
        f" | {'stranger FMR':>13}"
    )
    print(f"{'-' * 6} {'-' * 7} + {'-' * 8} {'-' * 7} {'-' * 7} + {'-' * 13}")

    results = []
    for margin in margins:
        for threshold in thresholds:
            closed = closed_set(closed_scores, truth, threshold, margin)
            opened = open_set(open_scores, threshold, margin)

            live = threshold == settings.match_threshold and margin == settings.match_margin
            print(
                f"{threshold:>6.2f} {margin:>7.2f} | "
                f"{closed.get('correct_rate', 0):>8.1%} "
                f"{closed.get('wrong_rate', 0):>7.2%} "
                f"{closed.get('reject_rate', 0):>7.1%} | "
                f"{opened.get('false_match_rate', 0):>13.2%}"
                + ("   <- in use" if live else "")
            )
            results.append({"threshold": threshold, "margin": margin, **closed, "open_set": opened})

    return results


def run(args: argparse.Namespace) -> int:
    path = Path(args.gallery).resolve()
    if not path.is_file():
        print(f"no such file: {path}", file=sys.stderr)
        return 1

    rows = load(path)
    print(f"{len(rows)} identities loaded")

    # ---- dataset label errors, before anything is measured -----------------
    full_matrix = as_matrix(rows).astype(np.float32)
    label_errors = find_label_errors(
        full_matrix, [r["label"] for r in rows], args.label_error_above
    )
    dropped = collapse_duplicates(label_errors)

    if label_errors:
        print(
            f"\n{len(label_errors)} cross-identity pairs scored at or above "
            f"{args.label_error_above}, which almost certainly means the dataset "
            f"has them filed under two names:"
        )
        for i, j, score in label_errors[:20]:
            print(f"  {score:.4f}  {rows[i]['label']}  ==  {rows[j]['label']}")
        if len(label_errors) > 20:
            print(f"  ... and {len(label_errors) - 20} more")
        print(
            f"\nDropping {len(dropped)} of them so each person appears once. "
            "Impostor scores are reported both ways below."
        )

    kept = [row for index, row in enumerate(rows) if index not in dropped]
    dirty_impostor = all_pairs_impostor(full_matrix)

    rows = kept
    with_probes = [r for r in rows if r.get("probes")]
    print(f"\n{len(rows)} identities, {len(with_probes)} with held-out probes")

    if args.holdout >= len(with_probes):
        print(
            f"--holdout {args.holdout} leaves nothing enrolled; "
            f"only {len(with_probes)} identities have probes",
            file=sys.stderr,
        )
        return 1

    # Identities kept out of the gallery entirely, to stand in for the people a
    # kiosk sees who have never enrolled. Chosen from those with probes, since
    # an identity with no second image gives nothing to test with.
    rng = random.Random(args.seed)
    strangers = set(rng.sample(range(len(with_probes)), args.holdout)) if args.holdout else set()
    stranger_labels = {with_probes[i]["label"] for i in strangers}

    enrolled = [r for r in rows if r["label"] not in stranger_labels]
    held_out = [with_probes[i] for i in sorted(strangers)]

    print(f"gallery: {len(enrolled)} identities")
    print(f"strangers held out of the gallery: {len(held_out)} identities")

    matrix = as_matrix(enrolled).astype(np.float32)
    gallery = [
        GalleryEntry(user_id=row["label"], embedding=matrix[i])
        for i, row in enumerate(enrolled)
    ]

    # Held-out images of people who ARE enrolled, with the gallery row each one
    # should resolve to.
    closed_probes, truth = [], []
    for index, row in enumerate(enrolled):
        for probe in row.get("probes", []):
            closed_probes.append(recognition.decode_embedding(probe["embedding_b64"]))
            truth.append(index)

    open_probes = [
        recognition.decode_embedding(p["embedding_b64"])
        for row in held_out
        for p in row["probes"]
    ]

    closed_matrix = (
        np.stack(closed_probes).astype(np.float32)
        if closed_probes
        else np.empty((0, recognition.EMBEDDING_DIM), dtype=np.float32)
    )
    open_matrix = (
        np.stack(open_probes).astype(np.float32)
        if open_probes
        else np.empty((0, recognition.EMBEDDING_DIM), dtype=np.float32)
    )
    truth = np.asarray(truth, dtype=np.int64)

    print(f"\ngenuine probes: {closed_matrix.shape[0]}")
    print(f"stranger probes: {open_matrix.shape[0]}")

    print("\nchecking the vectorised decision rule against identify()...")
    if not verify_agreement(closed_matrix, gallery, matrix, args.agreement_sample):
        print("\nAborting: the fast path does not reproduce the real rule.", file=sys.stderr)
        return 1

    # ---- 1. impostor scores, every cross-identity pair in the gallery -------
    print("\ncomputing all-pairs impostor scores...")
    impostor = all_pairs_impostor(matrix)
    impostor_stats = distribution(impostor, "impostor (different people)")

    above = int((impostor >= settings.match_threshold).sum())
    print(
        f"\n  {above:,} of {impostor.size:,} pairs "
        f"({above / max(impostor.size, 1):.6%}) reach the "
        f"match threshold of {settings.match_threshold}"
    )

    if dropped:
        # The same measurement without the duplicate labels removed, so the
        # effect of that decision is visible rather than taken on trust.
        dirty_above = int((dirty_impostor >= settings.match_threshold).sum())
        print(
            f"\n  before dropping duplicate labels: max {dirty_impostor.max():.4f}, "
            f"{dirty_above:,} of {dirty_impostor.size:,} pairs at or above "
            f"{settings.match_threshold}"
        )

    # ---- 2. genuine scores, held-out image against the stored vector --------
    genuine_stats = {}
    if closed_matrix.shape[0] > 0:
        genuine = np.einsum("ij,ij->i", closed_matrix, matrix[truth])
        genuine_stats = distribution(genuine, "genuine (same person, held-out image)")

        overlap = float(genuine.min()) - float(impostor.max())
        print(
            f"\n  separation: lowest genuine {genuine.min():.4f} vs "
            f"highest impostor {impostor.max():.4f} -- "
            + (f"gap {overlap:.4f}" if overlap > 0 else f"OVERLAP {-overlap:.4f}")
        )

    # ---- 3 & 4. identification at the live settings ------------------------
    closed_scores = closed_matrix @ matrix.T
    open_scores = open_matrix @ matrix.T

    # The second kind of dataset label error: a folder holding two people.
    mislabelled = find_probe_mislabels(
        closed_scores, truth, args.self_match_below, settings.match_threshold
    )
    if mislabelled.size > 0:
        best_other = closed_scores.copy()
        best_other[np.arange(closed_scores.shape[0]), truth] = -np.inf
        winners = best_other.argmax(axis=1)

        print(
            f"\n{mislabelled.size} probes match another enrolled identity while "
            f"barely matching their own row. Their folders hold two different "
            f"people, so they are counted as dataset errors rather than as the "
            f"model naming the wrong person:"
        )
        for k in mislabelled[:20]:
            print(
                f"  filed as {gallery[truth[k]].user_id:<28} "
                f"is {gallery[winners[k]].user_id:<28} "
                f"({best_other[k, winners[k]]:.4f} vs {closed_scores[k, truth[k]]:.4f} "
                "against its own row)"
            )
        if mislabelled.size > 20:
            print(f"  ... and {mislabelled.size - 20} more")

        dirty_closed = closed_set(
            closed_scores, truth, settings.match_threshold, settings.match_margin
        )
        keep = np.setdiff1d(np.arange(closed_scores.shape[0]), mislabelled)
        closed_scores = closed_scores[keep]
        truth = truth[keep]
        print(
            f"\n  counting them as errors instead would read "
            f"{dirty_closed['correct_rate']:.2%} correct and "
            f"{dirty_closed['wrong_rate']:.2%} wrong person."
        )

    live_closed = closed_set(
        closed_scores, truth, settings.match_threshold, settings.match_margin
    )
    live_open = open_set(open_scores, settings.match_threshold, settings.match_margin)

    print(
        f"\nidentification at the live settings "
        f"(threshold {settings.match_threshold}, margin {settings.match_margin}), "
        f"N = {len(gallery)}"
    )
    if live_closed:
        print("\n  enrolled people, held-out image")
        print(f"    correct           {live_closed['correct']:>6}  {live_closed['correct_rate']:.2%}")
        print(f"    WRONG PERSON      {live_closed['wrong']:>6}  {live_closed['wrong_rate']:.4%}")
        print(f"    ambiguous         {live_closed['ambiguous']:>6}")
        print(f"    no match          {live_closed['no_match']:>6}")
    # Named, not just counted. A rate hides whether the remaining failures are
    # the model confusing two strangers -- which would be alarming -- or the
    # things that actually turned up here: identical twins, siblings, and one
    # more person filed under a second spelling of their own name. Those are
    # different problems with different answers, and a percentage cannot tell
    # them apart.
    if live_closed and live_closed["wrong"] > 0:
        best, code = decide(
            closed_scores, settings.match_threshold, settings.match_margin
        )
        print("\n  every wrong-person match, by name")
        for k in np.where((code == 0) & (best != truth))[0][:20]:
            print(
                f"    {closed_scores[k, best[k]]:.4f}  "
                f"{gallery[truth[k]].user_id} -> {gallery[best[k]].user_id}"
            )

    if live_open:
        print("\n  strangers, never enrolled")
        print(f"    correctly refused {live_open['rejected']:>6}")
        print(f"    ambiguous         {live_open['ambiguous']:>6}")
        print(f"    FALSELY MATCHED   {live_open['false_matches']:>6}  {live_open['false_match_rate']:.4%}")

        if live_open["false_matches"] > 0:
            best, code = decide(
                open_scores, settings.match_threshold, settings.match_margin
            )
            stranger_labels_ordered = [
                row["label"] for row in held_out for _ in row["probes"]
            ]
            print("\n  every stranger falsely matched, by name")
            for k in np.where(code == 0)[0][:20]:
                print(
                    f"    {open_scores[k, best[k]]:.4f}  "
                    f"{stranger_labels_ordered[k]} -> {gallery[best[k]].user_id}"
                )

    # ---- threshold sweep ---------------------------------------------------
    sweep_results = sweep(
        closed_scores,
        truth,
        open_scores,
        args.thresholds,
        args.margins,
    )

    if args.json:
        out = Path(args.json).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "gallery_size": len(gallery),
                    "genuine_probes": int(closed_matrix.shape[0]),
                    "stranger_probes": int(open_matrix.shape[0]),
                    "settings": {
                        "match_threshold": settings.match_threshold,
                        "match_margin": settings.match_margin,
                        "model": settings.insightface_model,
                    },
                    "label_errors": [
                        {"a": rows[i]["label"], "b": rows[j]["label"], "score": round(s, 4)}
                        for i, j, s in label_errors[:100]
                    ],
                    "impostor": impostor_stats,
                    "genuine": genuine_stats,
                    "live": {"closed_set": live_closed, "open_set": live_open},
                    "sweep": sweep_results,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\nwrote {out}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--gallery", required=True, help="JSONL from embed_dataset.py")
    parser.add_argument(
        "--holdout",
        type=int,
        default=300,
        help="identities kept out of the gallery, to stand in for people who never enrolled",
    )
    parser.add_argument(
        "--thresholds",
        type=float,
        nargs="+",
        default=[0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65],
    )
    parser.add_argument("--margins", type=float, nargs="+", default=[0.0, 0.08])
    parser.add_argument(
        "--agreement-sample",
        type=int,
        default=200,
        help="probes checked against the real identify() before trusting the fast path",
    )
    parser.add_argument(
        "--self-match-below",
        type=float,
        default=0.20,
        help=(
            "a probe scoring under this against its own enrolled row, while "
            "matching someone else above the threshold, is treated as a "
            "mislabelled image rather than a wrong-person match"
        ),
    )
    parser.add_argument(
        "--label-error-above",
        type=float,
        default=0.85,
        help=(
            "cross-identity score above which a pair is treated as the same "
            "person filed under two names; every one is printed by name"
        ),
    )
    parser.add_argument("--json", help="write the full results here")
    parser.add_argument("--seed", type=int, default=20260822)

    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
