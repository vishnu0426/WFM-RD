"""Domain error hierarchy + the `{ error: { code, message, details } }` REST
envelope shape, reused verbatim from Module 01/02's `DomainErrorFilter`
(ADR-0015) for cross-platform consistency - this is a convention match, not a
shared-code dependency (different language, nothing to import).
"""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Base class for every error this service raises deliberately (as opposed
    to an unexpected exception, which is left as a generic 500 - see
    ADR-0015's reasoning for why the two are not conflated)."""

    code: str = "DOMAIN_ERROR"
    http_status: int = 400

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_envelope(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class TenantContextMissingError(DomainError):
    code = "TENANT_CONTEXT_MISSING"
    http_status = 400

    def __init__(self) -> None:
        super().__init__("No tenant context bound to this request.")


class InvalidTenantIdError(DomainError):
    code = "INVALID_TENANT_ID"
    http_status = 400

    def __init__(self, raw_value: str) -> None:
        super().__init__(f"'{raw_value}' is not a valid tenant id.", {"value": raw_value})


class InvalidAuthenticationError(DomainError):
    """GAP-08 fix (enterprise readiness audit, 2026-08-18): raised by
    `TenantContextMiddleware` for a missing/malformed `Authorization` header
    or a JWT that fails signature/issuer/audience/expiry verification
    against the root platform-core service's JWKS."""

    code = "INVALID_AUTHENTICATION"
    http_status = 401

    def __init__(self, reason: str) -> None:
        super().__init__(f"Authentication failed: {reason}.")


class NotFoundError(DomainError):
    code = "NOT_FOUND"
    http_status = 404


class ForecastRunNotFoundError(NotFoundError):
    def __init__(self, job_id: str) -> None:
        super().__init__(f"No forecast run with id '{job_id}'.", {"jobId": job_id})


class ScenarioSimulationNotFoundError(NotFoundError):
    def __init__(self, scenario_id: str) -> None:
        super().__init__(f"No scenario simulation with id '{scenario_id}'.", {"scenarioId": scenario_id})


class ScenarioBaseRunNotFoundError(NotFoundError):
    def __init__(self, base_forecast_run_id: str) -> None:
        super().__init__(
            f"No forecast run with id '{base_forecast_run_id}' to base a scenario on.",
            {"baseForecastRunId": base_forecast_run_id},
        )


class CcQueueNotFoundError(NotFoundError):
    def __init__(self, identifier: str) -> None:
        super().__init__(f"No contact-center queue matching '{identifier}'.", {"queue": identifier})


class CampaignNotFoundError(NotFoundError):
    def __init__(self, campaign_id: object) -> None:
        super().__init__(f"No campaign with id '{campaign_id}'.", {"campaignId": str(campaign_id)})


class BacklogAgeTemplateNotFoundError(NotFoundError):
    def __init__(self, template_id: object) -> None:
        super().__init__(
            f"No backlog age template with id '{template_id}'.", {"templateId": str(template_id)}
        )


class InvalidBacklogAgeThresholdsError(DomainError):
    code = "INVALID_BACKLOG_AGE_THRESHOLDS"
    http_status = 422

    def __init__(self) -> None:
        super().__init__("criticalThresholdMinutes must be greater than warningThresholdMinutes.")


class ScenarioBaseRunEmptyError(DomainError):
    """ADR-0024's own named failure mode - a base run with zero
    `ForecastDataPoint` rows (still genuinely `queued`, no model yet) has
    nothing for a scenario to adjust."""

    code = "SCENARIO_BASE_RUN_EMPTY"
    http_status = 422

    def __init__(self, base_forecast_run_id: str) -> None:
        super().__init__(
            f"Forecast run '{base_forecast_run_id}' has no forecast data points to build a scenario from.",
            {"baseForecastRunId": base_forecast_run_id},
        )


class InsufficientDataError(DomainError):
    """Raised by the Phase 2 data-quality gate; the error code is reserved now
    (ADR-0019) so §3.3's "distinguish INSUFFICIENT_DATA from a generic 500"
    requirement has a concrete home once that gate exists. Not raised anywhere
    in Phase 1's code paths."""

    code = "INSUFFICIENT_DATA"
    http_status = 422


class TftEntitlementMissingError(DomainError):
    code = "TFT_ENTITLEMENT_MISSING"
    http_status = 403

    def __init__(self, tenant_id: str) -> None:
        super().__init__(
            "Tenant is not entitled to GPU/TFT model training.", {"tenantId": tenant_id}
        )


class PlatformAdminRequiredError(DomainError):
    """ADR-0026, Decision 5 - `TenantContext.is_platform_admin` (bound since
    Phase 1's middleware, never previously used to gate anything) is now a
    real authorization check, not just a Postgres GUC passthrough."""

    code = "PLATFORM_ADMIN_REQUIRED"
    http_status = 403

    def __init__(self) -> None:
        super().__init__("This endpoint requires platform-admin privileges.")


STATUS_BY_CODE: dict[str, int] = {
    err.code: err.http_status
    for err in (
        TenantContextMissingError,
        InvalidTenantIdError,
        NotFoundError,
        InsufficientDataError,
        TftEntitlementMissingError,
        ScenarioBaseRunEmptyError,
        PlatformAdminRequiredError,
    )
}
