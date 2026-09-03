"""§7.1/ADR-0061 Decision 4's commercial-solver-fallback trigger - a
precise, measurable condition, no real Gurobi/CPLEX connected.
"""

from __future__ import annotations

from app.solver.commercial_fallback import (
    COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD,
    CommercialFallbackRequiredError,
    should_trigger_commercial_fallback,
)
from app.solver.types import SolveResult


def test_triggers_on_unknown_status_above_the_threshold() -> None:
    result = SolveResult(status="unknown")
    assert should_trigger_commercial_fallback(COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD + 1, result) is True


def test_does_not_trigger_at_or_below_the_threshold() -> None:
    result = SolveResult(status="unknown")
    assert should_trigger_commercial_fallback(COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD, result) is False


def test_does_not_trigger_on_a_definitive_infeasible_regardless_of_size() -> None:
    result = SolveResult(status="infeasible")
    assert should_trigger_commercial_fallback(COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD + 1, result) is False


def test_does_not_trigger_on_a_successful_solve() -> None:
    result = SolveResult(status="optimal")
    assert should_trigger_commercial_fallback(COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD + 1, result) is False


def test_error_message_names_the_trigger_condition_explicitly() -> None:
    error = CommercialFallbackRequiredError(employee_count=500)
    assert "500" in str(error)
    assert "not configured" in str(error)
