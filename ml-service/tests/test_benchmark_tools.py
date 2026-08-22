"""Tests for the benchmark tooling that measures 1:N at scale.

These matter more than tooling tests usually do. The numbers this tooling
produces are the ones the project makes claims from, so a quiet bug here does
not cause a visible failure -- it produces a plausible figure that is wrong,
which is worse than no figure at all.

No model is needed. Everything under test operates on unit vectors, so the
tests build embeddings with known similarities rather than running inference.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from benchmark_1n import (  # noqa: E402
    all_pairs_impostor,
    closed_set,
    collapse_duplicates,
    decide,
    find_label_errors,
    find_probe_mislabels,
    open_set,
)
from recognition import EMBEDDING_DIM, GalleryEntry, identify  # noqa: E402

THRESHOLD = 0.45
MARGIN = 0.08


def unit(*values: float) -> np.ndarray:
    """A unit vector whose first few components are given, rest zero."""
    vector = np.zeros(EMBEDDING_DIM, dtype=np.float32)
    vector[: len(values)] = values
    return vector / np.linalg.norm(vector)


def orthogonal(count: int) -> np.ndarray:
    """`count` mutually orthogonal unit vectors -- every pair scores exactly 0."""
    matrix = np.zeros((count, EMBEDDING_DIM), dtype=np.float32)
    for i in range(count):
        matrix[i, i] = 1.0
    return matrix


class TestAllPairsImpostor:
    def test_counts_each_pair_once(self):
        # n(n-1)/2, not n^2. Including the diagonal would put a 1.0 in the
        # impostor distribution for every row, and including both triangles
        # would double every count -- either would make the tail meaningless.
        matrix = orthogonal(10)
        assert all_pairs_impostor(matrix).size == 45

    def test_excludes_self_comparisons(self):
        matrix = orthogonal(6)
        assert all_pairs_impostor(matrix).max() == pytest.approx(0.0)

    def test_chunking_does_not_change_the_result(self):
        # The block loop exists so this can run at a gallery size where the full
        # matrix will not fit in memory. If a boundary were wrong it would drop
        # or duplicate pairs, and the distribution would shift silently.
        rng = np.random.default_rng(7)
        matrix = rng.normal(size=(37, EMBEDDING_DIM)).astype(np.float32)
        matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)

        big = np.sort(all_pairs_impostor(matrix, chunk=512))
        small = np.sort(all_pairs_impostor(matrix, chunk=4))

        assert big.size == small.size == 37 * 36 // 2
        assert np.allclose(big, small, atol=1e-6)


class TestLabelErrors:
    def test_finds_a_duplicated_identity(self):
        matrix = orthogonal(5)
        # Row 3 is a near copy of row 0 -- the same person under two names, which
        # is what LFW turned out to contain.
        matrix[3] = unit(1.0, 0.05)

        found = find_label_errors(matrix, [f"p{i}" for i in range(5)], 0.85)

        assert len(found) == 1
        i, j, score = found[0]
        assert {i, j} == {0, 3}
        assert score > 0.85

    def test_leaves_merely_similar_people_alone(self):
        # The threshold is high on purpose. Two people who genuinely look alike
        # are a real impostor pair and belong in the distribution.
        matrix = orthogonal(4)
        matrix[2] = unit(1.0, 1.4)  # ~0.58 against row 0

        assert find_label_errors(matrix, ["a", "b", "c", "d"], 0.85) == []

    def test_reports_pairs_worst_first(self):
        matrix = orthogonal(6)
        matrix[1] = unit(1.0, 0.5)  # ~0.894
        matrix[2] = unit(1.0, 0.05)  # ~0.999

        found = find_label_errors(matrix, [f"p{i}" for i in range(6)], 0.85)
        scores = [s for _, _, s in found]

        assert scores == sorted(scores, reverse=True)


class TestCollapseDuplicates:
    def test_keeps_one_of_a_pair(self):
        assert collapse_duplicates([(0, 3, 0.96)]) == {3}

    def test_keeps_one_of_a_group_of_three(self):
        # A person filed under three names. Dropping only one of the three would
        # leave the other two colliding with each other, which is the bug this
        # exists to prevent.
        dropped = collapse_duplicates([(0, 4, 0.96), (4, 9, 0.97)])
        assert dropped == {4, 9}

    def test_handles_a_group_discovered_out_of_order(self):
        dropped = collapse_duplicates([(5, 9, 0.9), (1, 5, 0.9)])
        assert dropped == {5, 9}

    def test_drops_nothing_when_there_is_nothing_to_drop(self):
        assert collapse_duplicates([]) == set()


class TestDecideMatchesTheService:
    """The sweep uses a vectorised rule; the service uses `identify`.

    A fast reimplementation of a decision rule is exactly the kind of thing that
    drifts, and if it drifts every published number is measuring a system nobody
    runs. The script checks agreement at runtime; these pin the specific cases.
    """

    def _both(self, probe, matrix):
        gallery = [GalleryEntry(user_id=str(i), embedding=matrix[i]) for i in range(len(matrix))]
        real = identify(probe, gallery, threshold=THRESHOLD, margin=MARGIN)
        index, code = decide(probe[None, :] @ matrix.T, THRESHOLD, MARGIN)
        return real, int(index[0]), int(code[0])

    def test_a_clear_match(self):
        matrix = orthogonal(5)
        real, index, code = self._both(unit(1.0, 0.2), matrix)
        assert real.decision.value == "matched"
        assert code == 0
        assert index == 0

    def test_nothing_close_enough(self):
        matrix = orthogonal(5)
        real, _, code = self._both(unit(*([1.0] * 8)), matrix)
        assert real.decision.value == "no_match"
        assert code == 1

    def test_two_candidates_too_close_to_call(self):
        # The 1:N safety rail. Rows 0 and 1 score near-identically, so the system
        # does not know which of them is standing there.
        matrix = orthogonal(5)
        real, _, code = self._both(unit(1.0, 0.99), matrix)
        assert real.decision.value == "ambiguous"
        assert code == 2

    def test_the_winner_is_the_highest_scorer_not_the_first_row(self):
        # argpartition does not sort, so an implementation that trusted its
        # order would return the wrong identity while still looking decisive.
        matrix = orthogonal(6)
        probe = unit(0.1, 0.2, 0.95)
        _, index, code = self._both(probe, matrix)
        assert code == 0
        assert index == 2


class TestOutcomeCounting:
    def test_a_wrong_match_is_not_counted_as_correct(self):
        # The number that represents money leaving an account that did not
        # authorise it. Everything else here is an inconvenience.
        matrix = orthogonal(4)
        probes = np.stack([unit(0.0, 1.0, 0.1)])
        truth = np.asarray([0])  # claims to be row 0, actually matches row 1

        result = closed_set(probes @ matrix.T, truth, THRESHOLD, MARGIN)

        assert result["correct"] == 0
        assert result["wrong"] == 1
        assert result["wrong_rate"] == 1.0

    def test_a_rejection_is_not_a_wrong_match(self):
        matrix = orthogonal(4)
        probes = np.stack([unit(*([1.0] * 8))])
        truth = np.asarray([0])

        result = closed_set(probes @ matrix.T, truth, THRESHOLD, MARGIN)

        assert result["wrong"] == 0
        assert result["no_match"] == 1
        assert result["reject_rate"] == 1.0

    def test_a_stranger_matching_anyone_is_a_false_match(self):
        # Open-set is the case a kiosk faces most: someone who never enrolled
        # walks up. There is no correct row for them, so any match at all is one.
        matrix = orthogonal(4)
        probes = np.stack([unit(1.0, 0.2)])

        result = open_set(probes @ matrix.T, THRESHOLD, MARGIN)

        assert result["false_matches"] == 1
        assert result["false_match_rate"] == 1.0

    def test_a_stranger_correctly_turned_away(self):
        matrix = orthogonal(4)
        probes = np.stack([unit(*([1.0] * 8))])

        result = open_set(probes @ matrix.T, THRESHOLD, MARGIN)

        assert result["false_matches"] == 0
        assert result["rejected"] == 1


class TestProbeMislabels:
    """A folder holding two people, versus a genuinely hard photograph.

    Both look identical from the self-score alone, and telling them apart is
    what decides whether the headline wrong-person figure is a real one. The
    rule is that a mislabelled image also matches somebody else well, while a
    hard image just fails.
    """

    def test_flags_an_image_that_is_someone_else(self):
        # Filed under row 0, but it is plainly row 2. This is Kate Capshaw's
        # folder containing a photograph of Steven Spielberg.
        matrix = orthogonal(4)
        probes = np.stack([unit(0.0, 0.0, 1.0, 0.05)])
        truth = np.asarray([0])

        found = find_probe_mislabels(probes @ matrix.T, truth, 0.20, THRESHOLD)

        assert found.tolist() == [0]

    def test_leaves_a_genuinely_hard_image_alone(self):
        # Scores badly against its own row and against everything else too --
        # bad light, hard pose. That is a real false rejection and removing it
        # would flatter the results.
        matrix = orthogonal(4)
        probes = np.stack([unit(*([1.0] * 40))])
        truth = np.asarray([0])

        assert find_probe_mislabels(probes @ matrix.T, truth, 0.20, THRESHOLD).size == 0

    def test_leaves_a_correct_match_alone(self):
        matrix = orthogonal(4)
        probes = np.stack([unit(1.0, 0.1)])
        truth = np.asarray([0])

        assert find_probe_mislabels(probes @ matrix.T, truth, 0.20, THRESHOLD).size == 0

    def test_does_not_mistake_a_strong_runner_up_for_a_mislabel(self):
        # Matches its own row well AND something else well. That is a genuine
        # near-collision the ambiguity rule exists for, not a labelling mistake,
        # and hiding it would remove the very case the margin was built to catch.
        matrix = orthogonal(4)
        probes = np.stack([unit(1.0, 0.98)])
        truth = np.asarray([0])

        assert find_probe_mislabels(probes @ matrix.T, truth, 0.20, THRESHOLD).size == 0


class TestTheMarginEarnsItsPlace:
    """The runner-up margin is the 1:N safety rail, and it is measurable.

    Against 5,182 LFW identities the wrong-person rate is 0.17% with the margin
    switched off and 0.00% with it on. This is that result in miniature: the
    same probe, the same gallery, decided differently by the margin alone.
    """

    def test_without_a_margin_a_near_tie_names_a_winner(self):
        matrix = orthogonal(4)
        probes = np.stack([unit(0.99, 1.0)])  # row 1 wins by 0.01
        truth = np.asarray([0])

        result = closed_set(probes @ matrix.T, truth, THRESHOLD, 0.0)

        assert result["wrong"] == 1, "a coin flip was reported as an identification"

    def test_with_a_margin_the_same_near_tie_is_refused(self):
        matrix = orthogonal(4)
        probes = np.stack([unit(0.99, 1.0)])
        truth = np.asarray([0])

        result = closed_set(probes @ matrix.T, truth, THRESHOLD, MARGIN)

        assert result["wrong"] == 0
        assert result["ambiguous"] == 1
