"""Matching and enrollment-fusion tests.

None of this needs a model. `identify`, `build_enrollment_embedding` and the
encoding helpers all operate on plain unit vectors, so the tests construct
embeddings with exactly known similarities instead of running inference.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recognition import (
    EMBEDDING_DIM,
    GalleryEntry,
    MatchDecision,
    build_enrollment_embedding,
    decode_embedding,
    encode_embedding,
    find_outlier_samples,
    identify,
)

THRESHOLD = 0.45
MARGIN = 0.08


@pytest.fixture
def rng():
    return np.random.default_rng(20260822)


def unit_vector(rng) -> np.ndarray:
    vector = rng.normal(size=EMBEDDING_DIM).astype(np.float32)
    return vector / np.linalg.norm(vector)


def at_similarity(base: np.ndarray, target: float, rng) -> np.ndarray:
    """Build a unit vector whose cosine similarity to `base` is exactly `target`.

    Decomposes into `target` along the base plus the remaining magnitude along
    a random orthogonal direction, which keeps the result unit-length.
    """
    orthogonal = rng.normal(size=base.shape).astype(np.float32)
    orthogonal -= (orthogonal @ base) * base
    orthogonal /= np.linalg.norm(orthogonal)

    vector = target * base + np.sqrt(1.0 - target**2) * orthogonal
    return (vector / np.linalg.norm(vector)).astype(np.float32)


def gallery_of(*embeddings: np.ndarray) -> list[GalleryEntry]:
    return [GalleryEntry(f"user{i}", e) for i, e in enumerate(embeddings)]


def run(probe, gallery):
    return identify(probe, gallery, threshold=THRESHOLD, margin=MARGIN)


# -- the two-condition match rule --------------------------------------


def test_clear_winner_is_matched(rng):
    probe = unit_vector(rng)
    result = run(
        probe,
        gallery_of(
            at_similarity(probe, 0.80, rng),
            at_similarity(probe, 0.20, rng),
            at_similarity(probe, 0.10, rng),
        ),
    )

    assert result.decision is MatchDecision.MATCHED
    assert result.user_id == "user0"


def test_best_score_below_threshold_is_no_match(rng):
    """An unenrolled walk-up must be rejected, not assigned to the closest user."""
    probe = unit_vector(rng)
    result = run(
        probe,
        gallery_of(at_similarity(probe, 0.30, rng), at_similarity(probe, 0.12, rng)),
    )

    assert result.decision is MatchDecision.NO_MATCH
    assert result.user_id is None


def test_near_tied_candidates_are_ambiguous(rng):
    """The rule that a plain threshold check would get wrong.

    Both candidates clear the threshold, so a 1:1-style check would accept the
    higher one — but the gap is inside the margin, which means the system
    cannot actually tell these two people apart on this frame.
    """
    probe = unit_vector(rng)
    result = run(
        probe,
        gallery_of(at_similarity(probe, 0.72, rng), at_similarity(probe, 0.70, rng)),
    )

    assert result.decision is MatchDecision.AMBIGUOUS
    assert result.user_id is None, "an ambiguous result must not name a user"
    assert result.top_score > THRESHOLD, "the threshold alone would have accepted this"


def test_wide_gap_above_threshold_is_matched(rng):
    probe = unit_vector(rng)
    result = run(
        probe,
        gallery_of(at_similarity(probe, 0.85, rng), at_similarity(probe, 0.50, rng)),
    )

    assert result.decision is MatchDecision.MATCHED
    assert result.margin >= MARGIN


def test_margin_is_not_applied_to_a_single_enrolled_user(rng):
    """With one entry there is no runner-up, so only the threshold applies."""
    probe = unit_vector(rng)
    result = run(probe, gallery_of(at_similarity(probe, 0.60, rng)))

    assert result.decision is MatchDecision.MATCHED
    assert result.gallery_size == 1


def test_empty_gallery_is_no_match(rng):
    result = run(unit_vector(rng), [])

    assert result.decision is MatchDecision.NO_MATCH
    assert result.gallery_size == 0
    assert result.candidates == []


# -- audit trail -------------------------------------------------------


def test_candidates_are_ranked_high_to_low(rng):
    probe = unit_vector(rng)
    result = run(
        probe,
        gallery_of(
            at_similarity(probe, 0.30, rng),
            at_similarity(probe, 0.85, rng),
            at_similarity(probe, 0.55, rng),
        ),
    )

    scores = [c.score for c in result.candidates]
    assert scores == sorted(scores, reverse=True)
    assert result.candidates[0].user_id == "user1"


def test_runner_up_is_reported_even_on_a_clean_match(rng):
    """Threshold tuning after the fact needs both scores, not just the winner."""
    probe = unit_vector(rng)
    result = run(
        probe,
        gallery_of(at_similarity(probe, 0.88, rng), at_similarity(probe, 0.41, rng)),
    )

    assert result.top_score == pytest.approx(0.88, abs=0.01)
    assert result.runner_up_score == pytest.approx(0.41, abs=0.01)
    assert result.margin == pytest.approx(result.top_score - result.runner_up_score, abs=1e-3)


def test_candidate_list_is_capped(rng):
    probe = unit_vector(rng)
    result = run(probe, gallery_of(*[at_similarity(probe, 0.3, rng) for _ in range(40)]))

    assert len(result.candidates) == 5, "the log keeps a head, not the whole gallery"


# -- enrollment fusion -------------------------------------------------


def test_fused_embedding_is_unit_length(rng):
    base = unit_vector(rng)
    samples = [at_similarity(base, 0.9, rng) for _ in range(6)]

    fused, _ = build_enrollment_embedding(samples)
    assert np.linalg.norm(fused) == pytest.approx(1.0, abs=1e-5)


def test_fusing_beats_any_single_sample(rng):
    """Why enrollment averages instead of storing one photo.

    Each sample is the same identity plus independent per-frame noise. The
    noise is uncorrelated between samples and largely cancels when averaged,
    so the fused vector sits closer to the true identity than the samples do.
    """
    identity = unit_vector(rng)
    samples = [at_similarity(identity, 0.75, rng) for _ in range(8)]

    fused, _ = build_enrollment_embedding(samples)
    best_single = max(float(s @ identity) for s in samples)

    assert float(fused @ identity) > best_single


def test_per_sample_similarity_is_reported(rng):
    base = unit_vector(rng)
    samples = [at_similarity(base, 0.9, rng) for _ in range(5)]

    _, similarities = build_enrollment_embedding(samples)
    assert len(similarities) == 5
    assert all(0.0 < s <= 1.0 for s in similarities)


def test_empty_enrollment_is_rejected():
    with pytest.raises(ValueError):
        build_enrollment_embedding([])


def test_a_bystander_sample_is_flagged_as_an_outlier(rng):
    """A frame that caught someone else must not reach the stored identity."""
    user = unit_vector(rng)
    samples = [at_similarity(user, 0.88, rng) for _ in range(5)]
    samples.insert(2, unit_vector(rng))  # a different person entirely

    assert find_outlier_samples(samples, threshold=0.40) == [2]


def test_consistent_samples_produce_no_outliers(rng):
    base = unit_vector(rng)
    samples = [at_similarity(base, 0.85, rng) for _ in range(6)]

    assert find_outlier_samples(samples, threshold=0.40) == []


# -- transport ---------------------------------------------------------


def test_encoding_round_trips_exactly(rng):
    original = unit_vector(rng)
    restored = decode_embedding(encode_embedding(original))

    np.testing.assert_array_equal(original, restored)


def test_decoding_rejects_a_wrong_sized_vector():
    import base64

    junk = base64.b64encode(np.zeros(128, dtype=np.float32).tobytes()).decode()
    with pytest.raises(ValueError, match="512"):
        decode_embedding(junk)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
