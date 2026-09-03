"""Alembic runtime config. Deliberately connects as `agno_migrator`
(DB_MIGRATION_*), never as `agno_scheduling_app` (app.config.Settings) -
preserves the two-role split's invariant that only the migrator role ever
runs DDL, matching Module 01/02's TypeORM split and Module 03's own
`migrations/env.py`.

`version_table_schema="scheduling"` is a deliberate divergence from Module
03's `env.py`: Module 03 lets Alembic track its revision state in the
default `public.alembic_version` table, which is fine as long as it's the
only Alembic-based service in this shared database. It is not anymore -
verified by actually running this migration against the same shared
Postgres Module 03 uses: without this line, `alembic upgrade head` here
fails with `Can't locate revision identified by '0004'`, because it reads
Module 03's own revision history out of the one shared `public.alembic_version`
row. Scoping this service's version table into its own `scheduling` schema
(which `agno_migrator` already owns) makes revision tracking single-tenant
per service, the same isolation principle ADR-0052 already applies to the
data itself. A future Module 05 (or later) should do the same rather than
rediscovering this collision.
"""

from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)


def _migrator_url() -> str:
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    username = os.getenv("DB_MIGRATION_USERNAME", "agno_migrator")
    password = os.getenv("DB_MIGRATION_PASSWORD", "changeme_local_only")
    return f"postgresql+psycopg2://{username}:{password}@{host}:{port}/{database}"


config.set_main_option("sqlalchemy.url", _migrator_url())

target_metadata = None  # hand-written SQL migrations only - see ADR-0016.


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table_schema="scheduling",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table_schema="scheduling",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
