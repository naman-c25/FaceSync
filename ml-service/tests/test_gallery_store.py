"""The resident gallery, and the promise that it decides nothing differently.

Holding the matrix here instead of shipping it on every scan is a performance
change, and a performance change to the matching path is only acceptable if it
is provably not an accuracy change. That is most of what this file is: the two
paths run against the same vectors and are required to agree exactly, not
approximately.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import gallery_store
from recognition import (
    EMBEDDING_DIM,
    GalleryEntry,
    encode_embedding,
    identify,
    identify_in,
)

THRESHOLD = 0.45
MARGIN = 0.08


@pytest.fixture(autouse=True)
def clean_store():
    gallery_store.clear()
    yield
    gallery_store.clear()


@pytest.fixture
def rng():
    return np.random.default_rng(20260830)


def unit_vector(rng) -> np.ndarray:
    vector = rng.normal(size=EMBEDDING_DIM).astype(np.float32)
    return vector / np.linalg.norm(vector)


def population(rng, n: int):
    """n distinct identities, as both wire entries and gallery entries."""
    vectors = [unit_vector(rng) for _ in range(n)]
    ids = [f"user-{i:04d}" for i in range(n)]
    wire = [(uid, encode_embedding(v)) for uid, v in zip(ids, vectors)]
    entries = [GalleryEntry(user_id=uid, embedding=v) for uid, v in zip(ids, vectors)]
    return ids, vectors, wire, entries


class TestSameAnswer:
    """The resident path and the ship-it path must not disagree."""

    def test_identical_decisions_across_many_probes(self, rng):
        # The one that matters. Every enrolled face is used as its own probe,
        # so each round has a true answer, a real runner-up, and a margin that
        # the rule actually has to weigh.
        ids, vectors, wire, entries = population(rng, 300)
        gallery_store.load("g1", wire)

        for probe in vectors:
            shipped = identify(probe, entries, threshold=THRESHOLD, margin=MARGIN)
            resident_ids, matrix = gallery_store.rows_for("g1", ids)
            held = identify_in(
                probe, resident_ids, matrix, threshold=THRESHOLD, margin=MARGIN
            )

            assert held.decision == shipped.decision
            assert held.user_id == shipped.user_id
            # Exact equality, not approximate. Both paths hand BLAS the same
            # contiguous float32 matrix, so anything but identical bytes out
            # would mean one of them is quietly doing different arithmetic.
            assert held.top_score == shipped.top_score
            assert held.runner_up_score == shipped.runner_up_score
            assert held.margin == shipped.margin
            assert held.gallery_size == shipped.gallery_size
            assert [(c.user_id, c.score) for c in held.candidates] == [
                (c.user_id, c.score) for c in shipped.candidates
            ]

    def test_agrees_on_a_stranger(self, rng):
        ids, _, wire, entries = population(rng, 50)
        gallery_store.load("g1", wire)
        stranger = unit_vector(rng)

        shipped = identify(stranger, entries, threshold=THRESHOLD, margin=MARGIN)
        resident_ids, matrix = gallery_store.rows_for("g1", ids)
        held = identify_in(
            stranger, resident_ids, matrix, threshold=THRESHOLD, margin=MARGIN
        )

        assert shipped.decision == held.decision
        assert shipped.top_score == held.top_score


class TestStaleness:
    """A gallery that is not the one the caller means is refused, not guessed."""

    def test_refuses_an_unknown_gallery_id(self, rng):
        ids, _, wire, _ = population(rng, 10)
        gallery_store.load("g1", wire)

        with pytest.raises(gallery_store.GalleryStale):
            gallery_store.rows_for("g2", ids)

    def test_refuses_before_anything_is_loaded(self):
        with pytest.raises(gallery_store.GalleryStale):
            gallery_store.rows_for("g1", ["user-0000"])

    def test_a_reload_replaces_rather_than_appends(self, rng):
        _, _, first, _ = population(rng, 10)
        gallery_store.load("g1", first)
        assert gallery_store.status()["size"] == 10

        _, _, second, _ = population(rng, 3)
        gallery_store.load("g2", second)
        assert gallery_store.status()["size"] == 3
        assert gallery_store.status()["gallery_id"] == "g2"

    def test_a_malformed_push_leaves_the_previous_gallery_serving(self, rng):
        # A bad push must not be able to empty the gallery -- that would turn
        # one broken deploy into every customer being a stranger.
        ids, _, wire, _ = population(rng, 10)
        gallery_store.load("g1", wire)

        with pytest.raises(ValueError):
            gallery_store.load("g2", [("bad", encode_embedding(np.zeros(8, dtype=np.float32)))])

        assert gallery_store.status()["gallery_id"] == "g1"
        assert gallery_store.status()["size"] == 10
        assert len(gallery_store.rows_for("g1", ids)[0]) == 10


class TestSubset:
    """Node decides who is eligible; the store answers for exactly those."""

    def test_returns_only_the_ids_asked_for_in_that_order(self, rng):
        ids, _, wire, _ = population(rng, 20)
        gallery_store.load("g1", wire)

        wanted = [ids[7], ids[2], ids[15]]
        got, matrix = gallery_store.rows_for("g1", wanted)

        assert got == wanted
        assert matrix.shape == (3, EMBEDDING_DIM)

    def test_rows_match_the_ids_they_are_returned_with(self, rng):
        # The bug this guards against is an off-by-one between the id list and
        # the matrix rows, which would attach one person's score to another
        # person's name -- a wrong-person match with no obvious symptom.
        ids, vectors, wire, _ = population(rng, 20)
        gallery_store.load("g1", wire)
        by_id = dict(zip(ids, vectors))

        wanted = [ids[11], ids[0], ids[19], ids[4]]
        got, matrix = gallery_store.rows_for("g1", wanted)

        for row, user_id in enumerate(got):
            assert np.array_equal(matrix[row], by_id[user_id])

    def test_unknown_ids_are_dropped_rather_than_raising(self, rng):
        ids, _, wire, _ = population(rng, 5)
        gallery_store.load("g1", wire)

        got, matrix = gallery_store.rows_for("g1", [ids[0], "who-is-this", ids[3]])

        assert got == [ids[0], ids[3]]
        assert matrix.shape == (2, EMBEDDING_DIM)

    def test_an_empty_pool_is_not_an_error(self, rng):
        _, _, wire, _ = population(rng, 5)
        gallery_store.load("g1", wire)

        got, matrix = gallery_store.rows_for("g1", [])
        assert got == []
        assert matrix.shape == (0, EMBEDDING_DIM)


class TestStorage:
    def test_stores_the_vectors_unchanged(self, rng):
        # No re-normalisation, no dtype change. Every threshold in this system
        # was measured against the bytes Node stored.
        ids, vectors, wire, _ = population(rng, 8)
        gallery_store.load("g1", wire)

        _, matrix = gallery_store.rows_for("g1", ids)
        assert matrix.dtype == np.float32
        for row, original in enumerate(vectors):
            assert np.array_equal(matrix[row], original)

    def test_reports_its_size_in_bytes(self, rng):
        _, _, wire, _ = population(rng, 100)
        gallery_store.load("g1", wire)
        # 100 x 512 float32 -- the number that decides whether this fits in a
        # 2GB container as enrollment grows.
        assert gallery_store.status()["bytes"] == 100 * EMBEDDING_DIM * 4
