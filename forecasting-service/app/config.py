from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, sourced from environment variables / `.env`.

    Mirrors the split Module 01/02 use in `.env.example`: the app connects as
    `agno_forecasting_app` (DB_*), never as the migration role - `alembic`
    reads DB_MIGRATION_* directly via `migrations/env.py`, not through this
    class, so a running instance of the app can never hold migrator
    credentials in memory.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    db_host: str = "localhost"
    db_port: int = 5432
    db_username: str = "agno_forecasting_app"
    db_password: str = "changeme_local_only"
    db_database: str = "agno_wfm"

    nats_url: str = "nats://localhost:4222"
    nats_stream_name: str = "AGNO_FORECASTING"

    # GAP-08 fix (enterprise readiness audit, 2026-08-18): the root
    # platform-core service's JWKS/issuer/audience, same values/naming
    # convention every Node service's own `CORE_JWKS_URI`/`OIDC_ISSUER`/
    # `OIDC_AUDIENCE` already use (e.g. adherence-compliance-service/.env.example).
    # `TenantContextMiddleware` verifies every request's `Authorization:
    # Bearer` JWT against these before binding any tenant/actor context -
    # previously it trusted the raw X-Tenant-Id/X-Actor-Id headers outright.
    core_jwks_uri: str = "http://localhost:3000/.well-known/jwks.json"
    oidc_issuer: str = "https://auth.agno-wfm.local"
    oidc_audience: str = "agno-core-api"

    # Phase 6 (ADR-0059) - this service's first gRPC surface
    # (ForecastService.GetForecastRequirements), mirroring Module 01/02's
    # own GRPC_URL convention (src/main.ts, default 0.0.0.0:5000) on a
    # distinct port so both can run locally at once.
    grpc_url: str = "0.0.0.0:6000"

    # Phase 3 (ADR-0021, Decision 4). `file:` is a local-dev-only stand-in
    # for a real tracking server + S3 artifact store, same posture
    # `docker-compose.yml`'s single-instance Postgres already has relative
    # to real RDS/Terraform provisioning.
    mlflow_tracking_uri: str = "file:./mlruns"
    mlflow_experiment_name: str = "forecasting"

    environment: str = "development"
    port: int = 8000

    # Comma-separated. This service has no browser client of its own; the
    # only caller crossing an Origin boundary is the web-console SPA (see
    # src/main.ts's identical CORS_ORIGIN convention on the root app).
    cors_origin: str = "http://localhost:5173"

    # Phase 8 (ADR-0026, Decision 4). Ray resource request for `tft`
    # candidates only - `0` (the default) keeps every `tft` candidate
    # CPU-scheduled, matching what's actually been verified in this
    # sandbox (no GPU present). Setting this without Ray actually seeing
    # GPU resources on the node makes the task queue forever - a real
    # deployment's job to get right, not this setting's.
    tft_num_gpus: int = 0

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.db_username}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_database}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
