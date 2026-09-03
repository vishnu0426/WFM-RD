"""ADR-0022, Decision 3's quality-gated promotion rule - pure function, no
DB, no Ray, no MLflow."""

from __future__ import annotations

import uuid

from app.services.training_service import MIN_RELATIVE_IMPROVEMENT, decide_promotion_winner


def test_no_candidates_promotes_nothing() -> None:
    assert decide_promotion_winner([], active_mape=10.0) is None


def test_first_ever_model_is_promoted_with_no_active_model_to_beat() -> None:
    candidate_id = uuid.uuid4()
    winner = decide_promotion_winner([(candidate_id, 15.0)], active_mape=None)
    assert winner == candidate_id


def test_best_of_batch_wins_among_multiple_fresh_candidates() -> None:
    better_id, worse_id = uuid.uuid4(), uuid.uuid4()
    winner = decide_promotion_winner([(worse_id, 12.0), (better_id, 8.0)], active_mape=None)
    assert winner == better_id


def test_a_candidate_that_barely_beats_the_active_model_is_not_promoted() -> None:
    """1% relative improvement, well under the 5% margin."""
    candidate_id = uuid.uuid4()
    active_mape = 10.0
    slightly_better_mape = 9.9
    winner = decide_promotion_winner([(candidate_id, slightly_better_mape)], active_mape=active_mape)
    assert winner is None


def test_a_candidate_that_clears_the_margin_is_promoted() -> None:
    candidate_id = uuid.uuid4()
    active_mape = 10.0
    winner = decide_promotion_winner(
        [(candidate_id, active_mape * (1 - MIN_RELATIVE_IMPROVEMENT))], active_mape=active_mape
    )
    assert winner == candidate_id


def test_a_candidate_worse_than_the_active_model_is_never_promoted() -> None:
    candidate_id = uuid.uuid4()
    winner = decide_promotion_winner([(candidate_id, 20.0)], active_mape=10.0)
    assert winner is None


def test_the_margin_boundary_is_inclusive() -> None:
    """Exactly 5% relative improvement should be enough (`<=`, not `<`)."""
    candidate_id = uuid.uuid4()
    active_mape = 10.0
    exactly_at_margin = active_mape * (1 - MIN_RELATIVE_IMPROVEMENT)
    winner = decide_promotion_winner([(candidate_id, exactly_at_margin)], active_mape=active_mape)
    assert winner == candidate_id


def test_custom_margin_is_respected() -> None:
    candidate_id = uuid.uuid4()
    active_mape = 10.0
    # 1% improvement, which clears a permissive 0.5% margin but wouldn't
    # clear the default 5%.
    winner = decide_promotion_winner(
        [(candidate_id, 9.9)], active_mape=active_mape, min_relative_improvement=0.005
    )
    assert winner == candidate_id
