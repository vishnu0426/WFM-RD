from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, sourced from environment variables / `.env`.

    Mirrors the split Module 01/02/03 use in `.env.example`: the app connects
    as `agno_scheduling_app` (DB_*), never as the migration role - `alembic`
    reads DB_MIGRATION_* directly via `migrations/env.py`, not through this
    class, so a running instance of the app can never hold migrator
    credentials in memory.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    db_host: str = "localhost"
    db_port: int = 5432
    db_username: str = "agno_scheduling_app"
    db_password: str = "changeme_local_only"
    db_database: str = "agno_wfm"

    nats_url: str = "nats://localhost:4222"
    nats_stream_name: str = "AGNO_SCHEDULING"

    # GAP-08 fix (enterprise readiness audit, 2026-08-18): the root
    # platform-core service's JWKS/issuer/audience - same values/naming
    # convention every Node service's own `CORE_JWKS_URI`/`OIDC_ISSUER`/
    # `OIDC_AUDIENCE` already use, and forecasting-service's identical
    # addition. `TenantContextMiddleware` verifies every request's
    # `Authorization: Bearer` JWT against these before binding any
    # tenant/actor context - previously it trusted the raw
    # X-Tenant-Id/X-Actor-Id headers outright.
    core_jwks_uri: str = "http://localhost:3000/.well-known/jwks.json"
    oidc_issuer: str = "https://auth.agno-wfm.local"
    oidc_audience: str = "agno-core-api"

    # Phase 6 (ADR-0059) - §4.3's mid-solve gRPC pulls. `core_grpc_url`
    # reaches Module 01/02's combined `EmployeeService`/`PolicyService`
    # (src/main.ts, default 0.0.0.0:5000); `forecasting_grpc_url` reaches
    # Module 03's `ForecastService` (forecasting-service/app/config.py,
    # default 0.0.0.0:6000).
    core_grpc_url: str = "localhost:5000"
    forecasting_grpc_url: str = "localhost:6000"
    # Module 06 Phase 5 (§3.4, ADR-0078) - reaches attendance-leave-service's
    # `LeaveService.GetUnavailability` (attendance-leave-service/src/main.ts,
    # default 0.0.0.0:7050 - moved off the originally-documented :7000,
    # which collides with macOS's own AirPlay Receiver in local dev).
    # Closes the permanent gap ADR-0059 documented - "no real leave/
    # unavailability source exists anywhere in the platform... until
    # Module 06 ships."
    attendance_grpc_url: str = "localhost:7050"
    # Module 08 (docs/adr/0102) - reaches adherence-compliance-service's
    # `ComplianceRuleService.GetActiveRule` (adherence-compliance-service/
    # src/main.ts, default 0.0.0.0:7100). `_resolve_policy` merges this
    # jurisdiction's legal floor into `EmploymentPolicy`, stricter-wins per
    # field, closing §0.6's other required integration point (the first
    # being Module 02's own write-time gate, ADR-0101).
    compliance_grpc_url: str = "localhost:7100"

    # Module 07 (docs/adr/0082) - this service's first gRPC *server* bind
    # address, exposing `SchedulingEligibilityService`. `0.0.0.0`, not
    # `localhost` - it's a bind address for `grpc.aio.server().add_insecure_port`,
    # not an outbound target like the three `*_grpc_url` fields above.
    scheduling_grpc_bind_address: str = "0.0.0.0:8102"

    environment: str = "development"
    port: int = 8100

    # Comma-separated. This service has no browser client of its own; the
    # only caller crossing an Origin boundary is the web-console SPA (see
    # src/main.ts's identical CORS_ORIGIN convention on the root app, and
    # forecasting-service/app/config.py's own copy of this same field).
    cors_origin: str = "http://localhost:5173"

    # Phase 7/8 (ADR-0060) - `app/worker.py`'s own tuning. `poll_interval`
    # is how long an idle worker sleeps between claim attempts;
    # `reaper_stuck_threshold_seconds` must exceed the real p99 solve time
    # (§0.5) - too short and the reaper requeues jobs that are simply still
    # solving, not stuck. `shutdown_grace_seconds` is read by the
    # orchestration platform's own termination lifecycle (a Kubernetes
    # `preStop` hook / `terminationGracePeriodSeconds`), not enforced by
    # this process itself - the worker's own graceful-drain loop always
    # waits for its current claim to finish, however long that takes.
    worker_poll_interval_seconds: float = 1.0
    worker_reaper_stuck_threshold_seconds: int = 300
    worker_reaper_max_attempts: int = 3
    worker_shutdown_grace_seconds: int = 300
    # `app/core/worker_metrics.py`'s own scrape port - distinct from the
    # HTTP app's `port` (default 8100), since a worker is a separate OS
    # process with no other HTTP surface. Each worker instance needs its
    # own port when running multiple on one host (local dev) - a real
    # deployment gives each pod/instance this same default, since they're
    # separate network namespaces there.
    worker_metrics_port: int = 8101

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.db_username}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_database}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
