"""§8's worker-side metrics (solve time distribution, relaxation-category
frequency, terminal-status counts) - a separate registry/HTTP server from
the main app's own `/metrics` (`app/core/metrics.py`), since `app/worker.py`
is a distinct OS process with no HTTP surface of its own until this module
gives it one (`prometheus_client.start_http_server`, called from
`app/worker.py`'s own `_main`).

**"Infeasible rate by org unit" (§8's own wording) is deliberately *not* a
Prometheus label here** - `org_unit_id` is unbounded cardinality, the same
discipline `forecasting-service/app/core/metrics.py`'s own "route label,
never raw path" comment already states for this platform (ADR-0026
Decision 7). Every terminal outcome is logged instead, with `org_unit_id`
as a structured JSON field (`job_service._publish`) - a real deployment
slices "infeasible rate by org unit" from a log-aggregation backend
(Loki/Elasticsearch), not from Prometheus. Flagged explicitly in the Phase
7/8 readiness checklist as a real, deliberate architectural choice, not an
oversight.
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Histogram

WORKER_REGISTRY = CollectorRegistry()

JOBS_TOTAL = Counter(
    "scheduling_jobs_total",
    "Total scheduling jobs reaching a terminal status.",
    ["status"],
    registry=WORKER_REGISTRY,
)
SOLVE_DURATION_SECONDS = Histogram(
    "scheduling_solve_duration_seconds",
    "CP-SAT solve duration in seconds, per decomposition group, by scope-size bucket.",
    ["scope_size"],
    registry=WORKER_REGISTRY,
)
RELAXATION_CATEGORY_TOTAL = Counter(
    "scheduling_relaxation_category_total",
    "How often each §5 relaxation category is attempted across infeasible jobs.",
    ["category"],
    registry=WORKER_REGISTRY,
)


def scope_size_bucket(employee_count: int) -> str:
    """Matches `app/solver/decomposition.py::DECOMPOSITION_EMPLOYEE_THRESHOLD`
    (200) as the medium/large boundary - "large" here means "a scope
    decomposition would have engaged on," a directly meaningful bucket for
    reading this histogram, not an arbitrary round number."""
    if employee_count < 50:
        return "small"
    if employee_count <= 200:
        return "medium"
    return "large"
