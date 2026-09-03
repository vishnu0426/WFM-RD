"""§7.1/ADR-0061 Decision 4: the commercial-solver-fallback trigger. A
precise, measurable condition, deliberately not connected to a real
Gurobi/CPLEX license - none exists in this environment, and §1 is explicit
that this is "a budgeted fallback... not a silent substitution." Faking a
call to a commercial solver that isn't actually licensed would be exactly
the silent substitution the module prompt warns against; refusing to build
one is the honest choice.
"""

from __future__ import annotations

from app.solver.types import SolveResult

#: A sub-problem above this size that CP-SAT can't resolve within its time
#: budget is treated as a genuine scale problem, not "just needs a bit more
#: time" - see ADR-0061 Decision 4 for why this threshold and not a smaller
#: one (small sub-problems timing out are almost always a modeling bug, not
#: a scale problem a bigger solver would fix).
COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD = 300


class CommercialFallbackRequiredError(Exception):
    """Raised by `app.worker` when `should_trigger_commercial_fallback`
    fires. Always results in the job resolving to `failed` with this
    exception's own message as the reason - never a silent `unknown`-status
    job left for someone to puzzle over later."""

    def __init__(self, employee_count: int) -> None:
        self.employee_count = employee_count
        super().__init__(
            f"CP-SAT exceeded its time budget on a {employee_count}-employee sub-problem "
            f"(> {COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD}); commercial solver fallback "
            "is not configured in this environment (no Gurobi/CPLEX license - see ADR-0061)."
        )


def should_trigger_commercial_fallback(employee_count: int, result: SolveResult) -> bool:
    """`result.status == "unknown"` (CP-SAT exhausted its time budget with
    neither a solution nor a proof of infeasibility - see
    `SolveResult.status`'s own docstring) on a sub-problem large enough that
    the size, not a modeling defect, is the plausible cause."""
    return result.status == "unknown" and employee_count > COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD
