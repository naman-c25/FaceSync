"""The enrolled signatures, held in memory as one matrix.

Why this exists
---------------
Before it, Node shipped the whole gallery on every single scan. At two
thousand users that is 5.6MB of base64 per match; at ten thousand it is 21MB,
and every one of those requests paid for it three times over -- serialised in
Node, parsed here, then decoded one entry at a time into a list that `np.stack`
immediately copied into a fresh matrix. Measured at N = 10,000 that was about
270ms of transport around a comparison that takes 0.345ms.

So the matrix lives here instead. Node pushes it once, and a scan sends the
ids it wants compared rather than the vectors themselves.

What has not changed
--------------------
The arithmetic. Rows are stored exactly as Node sent them -- no
re-normalisation, no dtype change -- and selecting rows by id produces the same
contiguous float32 matrix `np.stack` used to build, so `matrix @ probe` sees
identical bytes and returns identical scores. That matters more than the speed:
every threshold in this system was measured against the old path.

Staleness
---------
Node owns the truth and stamps each load with a `gallery_id`. A request
carrying a different one is refused rather than answered from a stale matrix,
because a gallery missing the person standing at the till is a `no_match` that
looks exactly like a stranger. Node re-pushes and retries; a restart of either
process resolves the same way.
"""

from __future__ import annotations

import threading

import numpy as np

import recognition

# One lock around the whole store. Loads are rare and reads are microseconds,
# so there is nothing to gain from anything finer, and a partially replaced
# matrix would be a very hard bug to see.
_lock = threading.Lock()

_gallery_id: str | None = None
_ids: list[str] = []
_index: dict[str, int] = {}
_matrix: np.ndarray = np.empty((0, recognition.EMBEDDING_DIM), dtype=np.float32)


class GalleryStale(Exception):
    """The caller's gallery_id is not the one loaded."""

    def __init__(self, expected: str | None) -> None:
        super().__init__("gallery is not loaded, or is a different one")
        self.loaded = expected


def load(gallery_id: str, entries: list[tuple[str, str]]) -> int:
    """Replace the resident gallery. `entries` is (user_id, embedding_b64).

    Decoding happens once here rather than once per scan, which is the whole
    point. A malformed row raises before anything is swapped in, so a bad push
    leaves the previous gallery serving rather than emptying it.
    """
    decoded = [recognition.decode_embedding(b64) for _, b64 in entries]

    matrix = (
        np.ascontiguousarray(np.stack(decoded), dtype=np.float32)
        if decoded
        else np.empty((0, recognition.EMBEDDING_DIM), dtype=np.float32)
    )
    ids = [user_id for user_id, _ in entries]

    global _gallery_id, _ids, _index, _matrix
    with _lock:
        _gallery_id = gallery_id
        _ids = ids
        _index = {user_id: row for row, user_id in enumerate(ids)}
        _matrix = matrix

    return len(ids)


def rows_for(gallery_id: str, candidate_ids: list[str]) -> tuple[list[str], np.ndarray]:
    """The subset of the gallery a scan asked for, in the order it asked.

    Ids the store does not hold are dropped rather than raising: Node decides
    membership from the database and this only has to answer for what it was
    given. An id that is genuinely new arrives with a new `gallery_id`, which
    is refused above instead.
    """
    with _lock:
        if gallery_id is None or gallery_id != _gallery_id:
            raise GalleryStale(_gallery_id)

        rows = [_index[user_id] for user_id in candidate_ids if user_id in _index]
        ids = [user_id for user_id in candidate_ids if user_id in _index]

        if not rows:
            return [], np.empty((0, recognition.EMBEDDING_DIM), dtype=np.float32)

        # Fancy indexing copies into a fresh contiguous array -- the same shape,
        # dtype and layout `np.stack` produced on the old path.
        return ids, _matrix[rows]


def status() -> dict:
    with _lock:
        return {
            "gallery_id": _gallery_id,
            "size": len(_ids),
            "bytes": int(_matrix.nbytes),
        }


def clear() -> None:
    global _gallery_id, _ids, _index, _matrix
    with _lock:
        _gallery_id = None
        _ids = []
        _index = {}
        _matrix = np.empty((0, recognition.EMBEDDING_DIM), dtype=np.float32)
