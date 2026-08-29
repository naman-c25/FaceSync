"""Does clustering the gallery let us skip any of it? Measured, on real faces.

    .venv/Scripts/python tools/bucket_check.py

Runs `bucketed_gallery.BucketedGallery` against an exhaustive scan over the
5,486 real ArcFace embeddings in `benchmark-data/gallery.jsonl`, and reports
three things: whether the top five come back identical, how many embeddings the
pruning actually managed to skip, and which is faster.

The answer is none, and the full scan. See the module docstring in
`bucketed_gallery.py` for why -- it is a property of 512 dimensions rather than
of this implementation, and it is the reason production vector indexes are all
approximate.
"""

import base64, json, pathlib, sys, time
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bucketed_gallery import BucketedGallery

def load(path, limit):
    rows, probes = [], []
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            rows.append(np.frombuffer(base64.b64decode(r["embedding_b64"]), dtype=np.float32))
            if r.get("probes") and len(probes) < 200:
                p = r["probes"][0]
                b64 = p.get("embedding_b64") if isinstance(p, dict) else p
                if isinstance(b64, str):
                    probes.append(np.frombuffer(base64.b64decode(b64), dtype=np.float32))
            if len(rows) >= limit:
                break
    return np.stack(rows), probes

GALLERY = r"F:\FacePay\benchmark-data\gallery.jsonl"

for N in (2017, 5000):
    matrix, probes = load(GALLERY, N)
    matrix = matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
    if not probes:
        # No stored probes: use gallery faces themselves, which is the
        # realistic query -- a probe always lands near somebody.
        probes = [matrix[i] for i in range(0, len(matrix), max(1, len(matrix)//100))]
    probes = [p / np.linalg.norm(p) for p in probes][:100]

    t = time.perf_counter(); index = BucketedGallery(matrix); build = time.perf_counter() - t

    mismatches, compared = 0, []
    for p in probes:
        full = matrix @ p
        part, n = index.scores(p, top_k=5)
        compared.append(n)
        # The claim: same top five, same scores.
        a = np.argsort(full)[::-1][:5]
        b = np.argsort(part)[::-1][:5]
        if not np.array_equal(a, b) or not np.allclose(full[a], part[b], atol=0):
            mismatches += 1

    def timeit(fn, reps=30):
        best = 1e9
        for _ in range(reps):
            s = time.perf_counter(); fn(); best = min(best, time.perf_counter() - s)
        return best * 1000

    q = probes[0]
    full_ms = timeit(lambda: matrix @ q)
    buck_ms = timeit(lambda: index.scores(q, top_k=5))

    print(f"\nN = {N}   buckets = {len(index.buckets)}   index build = {build*1000:.0f} ms")
    print(f"  top-5 identical on {len(probes)} probes : {'YES' if mismatches == 0 else f'NO ({mismatches} differ)'}")
    print(f"  embeddings actually compared          : {np.mean(compared):.0f} of {N}  ({np.mean(compared)/N*100:.0f}%)")
    print(f"  full scan                              : {full_ms:.3f} ms")
    print(f"  bucketed                               : {buck_ms:.3f} ms")
    print(f"  verdict                                : {'FASTER' if buck_ms < full_ms else 'SLOWER'} ({full_ms/buck_ms:.2f}x)")
