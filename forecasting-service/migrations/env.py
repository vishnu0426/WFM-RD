"""Alembic runtime config. Deliberately connects as `agno_migrator`
(DB_MIGRATION_*), never as `agno_forecasting_app` (app.config.Settings) -
preserves the two-role split's invariant that only the migrator role ever
runs DDL, matching Module 01/02's TypeORM `data-source.ts` split.

`version_table_schema="forecasting"` (Phase 6 fix, ADR-0059): this file
previously let Alembic track revision state in the default, unscoped
`alembic_version` table - exactly the collision Module 04's own
`migrations/env.py` already documented and fixed for itself ("a future
Module 05 (or later) should do the same rather than rediscovering this
collision"), which this file never actually picked up. Discovered for real
running this service's migrations against the same shared Postgres Module 04
uses: without this line, this service's `alembic upgrade head` was silently
reading and about to advance *Module 04's own* `scheduling.alembic_version`
row (both services' migration files happen to number revisions `0001`-`0004`
too, so the wrong table's value looked plausible enough that Alembic tried
to run this service's `0004` next without ever having applied `0001`-`0003`
here at all) - a real, dangerous cross-service migration-tracking bug, not
a hypothetical one. Scoping this service's version table into its own
`forecasting` schema (which `agno_migrator` already owns) makes revision
tracking single-tenant per service, matching ADR-0052's isolation principle
for the data itself.
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
        version_table_schema="forecasting",
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
            version_table_schema="forecasting",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
