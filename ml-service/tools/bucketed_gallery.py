"""Skip whole groups of faces that provably cannot win, without approximating.

The idea is the obvious one: cluster the gallery, and at query time only search
the clusters that look promising. Every approximate nearest-neighbour index --
IVF, LSH, HNSW -- is a version of it.

What makes those *approximate* is that they guess which clusters are promising.
That is exactly what this system cannot afford. A match here needs two numbers,
the best score and the runner-up, and the gap between them is what turns a
confident answer into `AMBIGUOUS`. An index that misses the true runner-up does
not return a slightly worse answer; it returns a *wider margin than really
exists*, which converts "I do not know" into a confident wrong name. The 0.00%
wrong-person figure was measured against an exhaustive search and would stop
describing the system.

So this prunes exactly, using the triangle inequality rather than a guess.

The bound
---------
Embeddings are unit vectors, so cosine similarity is the dot product. For any
member `x` of a bucket with centre `c`:

    x . q  =  (c + (x - c)) . q  =  c . q + (x - c) . q
           <= c . q + ||x - c|| ||q||        (Cauchy-Schwarz)
           =  c . q + ||x - c||              (q is a unit vector)
           <= c . q + r                      (r = the bucket's radius)

`c . q + r` is therefore a ceiling on what *anything* in that bucket can score.
Visit buckets in descending order of that ceiling, keep a running top-k, and the
moment a bucket's ceiling falls below the k-th best score found so far, every
remaining bucket can be dropped -- not because they are unlikely to help, but
because they cannot.

What happened when it was run
-----------------------------
The algebra is right and the code is right -- `tools/bucket_check.py` confirms
the top five come back identical to an exhaustive scan across a hundred real
probes. It is also useless, and the reason is worth keeping:

    N = 2017, 44 buckets   compared 2017 of 2017  (100%)   0.251 ms
    N = 5000, 70 buckets   compared 5000 of 5000  (100%)   0.614 ms
    full scan                                              0.070 / 0.092 ms

**Not one bucket was ever pruned.** In 512 dimensions any cluster of face
embeddings has a radius close to the sqrt(2) that separates two arbitrary unit
vectors, while `c . q` spans a far narrower range. So every ceiling
`c . q + r` sits comfortably above the best score anything actually achieves,
and the test that would skip a bucket never fires.

That is the curse of dimensionality, not a tuning problem, and no choice of `k`
escapes it. It is also precisely why every production vector index is
approximate: exact metric pruning does not work at this width, so IVF, LSH and
HNSW give up exactness to get the speed.

Which settles the trade for this system. You may have exact answers or you may
have pruning; at 512 dimensions you cannot have both. Since the margin rule
needs the true runner-up, exact is not negotiable -- and once pruning is off the
table, `matrix @ probe` is already the fastest thing available. BLAS goes from
2,017 rows to 5,000 for 1.3x the time; a hundred thousand would still be about
two milliseconds.

Kept, unused, as the measurement behind that decision.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def _kmeans(matrix: np.ndarray, k: int, *, iterations: int = 12) -> np.ndarray:
    """Assign every row to one of `k` groups. Plain Lloyd's algorithm.

    Written out rather than imported from scikit-learn because the service
    deliberately carries no ML framework beyond ONNX Runtime and MediaPipe, and
    twenty lines is cheaper than a dependency that pulls in SciPy at start-up.

    Cluster quality only affects how much pruning is possible, never what is
    returned -- a bad clustering makes this slower, not wrong. That is why a
    fixed iteration count with no convergence check is fine here.
    """
    rng = np.random.default_rng(0)  # Deterministic, so two runs bucket alike.
    centres = matrix[rng.choice(len(matrix), size=k, replace=False)].copy()

    labels = np.zeros(len(matrix), dtype=np.int32)
    for _ in range(iterations):
        # (N, k) distances via the dot product, since all rows are unit norm.
        similarity = matrix @ centres.T
        new_labels = np.argmax(similarity, axis=1).astype(np.int32)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels

        for group in range(k):
            members = matrix[labels == group]
            # An emptied cluster keeps its previous centre rather than
            # collapsing to the origin, which would make its radius enormous
            # and its bound useless.
            if len(members) > 0:
                centres[group] = members.mean(axis=0)

    return labels, centres


@dataclass
class Bucket:
    start: int
    end: int
    centre: np.ndarray
    radius: float


class BucketedGallery:
    """An exhaustive search that is allowed to skip provably hopeless groups."""

    def __init__(self, matrix: np.ndarray, k: int | None = None):
        n = len(matrix)
        # sqrt(N) is the usual starting point: it balances the cost of scoring
        # the centres against the size of what survives pruning.
        k = k or max(1, min(int(np.sqrt(n)), n))

        labels, centres = _kmeans(matrix, k)

        # Rows are reordered so each bucket is one contiguous slice. Without
        # this, visiting a bucket means a gather across scattered rows, and at
        # this size the scattered reads cost more than the arithmetic saved.
        self.order = np.argsort(labels, kind="stable")
        self.matrix = np.ascontiguousarray(matrix[self.order])

        sorted_labels = labels[self.order]
        self.buckets: list[Bucket] = []
        for group in range(k):
            hits = np.flatnonzero(sorted_labels == group)
            if len(hits) == 0:
                continue
            start, end = int(hits[0]), int(hits[-1]) + 1
            members = self.matrix[start:end]
            radius = float(np.linalg.norm(members - centres[group], axis=1).max())
            self.buckets.append(Bucket(start, end, centres[group], radius))

        self.centres = np.stack([b.centre for b in self.buckets])
        self.radii = np.array([b.radius for b in self.buckets], dtype=np.float32)

    def scores(self, probe: np.ndarray, top_k: int = 5) -> tuple[np.ndarray, int]:
        """Every score, with untouched entries left at -inf.

        Returns the score vector in *original* gallery order, plus how many
        embeddings were actually compared. Anything pruned is left at -inf,
        which is correct by construction: the bound proved it could not reach
        the top `top_k`, so its true value cannot change the answer.
        """
        ceilings = self.centres @ probe + self.radii
        visit = np.argsort(ceilings)[::-1]

        out = np.full(len(self.matrix), -np.inf, dtype=np.float32)
        best: list[float] = []
        compared = 0

        for index in visit:
            # The k-th best found so far. Once a ceiling cannot reach it, no
            # later bucket can either -- they are in descending ceiling order.
            if len(best) >= top_k and ceilings[index] <= best[top_k - 1]:
                break

            bucket = self.buckets[index]
            chunk = self.matrix[bucket.start : bucket.end] @ probe
            out[bucket.start : bucket.end] = chunk
            compared += len(chunk)

            best.extend(chunk.tolist())
            best.sort(reverse=True)
            del best[top_k:]

        # Back to the caller's ordering, so indices line up with their gallery.
        restored = np.empty_like(out)
        restored[self.order] = out
        return restored, compared
