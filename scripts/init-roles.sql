-- Local dev bootstrap only. In real environments these roles/passwords are
-- provisioned by Terraform + Vault dynamic secrets, never checked into git
-- or set via a plaintext init script.
--
-- Two-role split is load-bearing for §2.2 rule 2 (AuditLog is append-only):
--   agno_migrator - owns the "core" schema, runs DDL migrations, may
--                   INSERT/SELECT/UPDATE/DELETE everywhere (used only by the
--                   migration job, never by the running application).
--   agno_app      - used by the NestJS application at runtime. Explicitly
--                   denied UPDATE/DELETE on audit_log at the GRANT level
--                   (defense in depth below the application-layer guard).

-- Module 03 (Forecasting Engine, Python/FastAPI) reuses agno_migrator for DDL
-- (same as Module 01/02) but gets its OWN runtime role, agno_forecasting_app,
-- rather than reusing agno_app - see docs/adr/0017. Keeps a Python service's
-- GRANT-level blast radius and credential-rotation lifecycle independent of
-- the Node service's, and means a raw/unguarded query bug in either service
-- can only ever touch the schema that service actually owns.
CREATE ROLE agno_migrator WITH LOGIN PASSWORD 'changeme_local_only';
CREATE ROLE agno_app WITH LOGIN PASSWORD 'changeme_local_only';
CREATE ROLE agno_forecasting_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 04 (Scheduling Engine, Python/FastAPI) - same shared-schema,
-- separate-role pattern as Module 03, see docs/adr/0052.
CREATE ROLE agno_scheduling_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 05 (Intraday/Real-Time Management, Node/NestJS) - same
-- shared-database, new-schema-new-role pattern as Module 03/04, see
-- docs/adr/0066. The second TypeORM-based service in this platform
-- (alongside root's own Module 01/02 app), not Python/Alembic.
CREATE ROLE agno_intraday_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 06 (Attendance & Leave Management, Node/NestJS) - same
-- shared-database, new-schema-new-role pattern as Module 03/04/05, see
-- docs/adr/0073.
CREATE ROLE agno_attendance_leave_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 07 (Shift Marketplace, Node/NestJS) - same shared-database,
-- new-schema-new-role pattern as Module 03/04/05/06, see docs/adr/0083.
CREATE ROLE agno_marketplace_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 08 (Adherence & Compliance, Node/NestJS) - same shared-database,
-- new-schema-new-role pattern as Module 03/04/05/06/07, see docs/adr/0093.
CREATE ROLE agno_compliance_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 09 (Analytics & Reporting, Node/NestJS) - same shared-database,
-- new-schema-new-role pattern as Module 03/04/05/06/07/08, see
-- docs/adr/0108. No new role beyond this one: the source spec's "read
-- replica per owning module" is a streaming physical replica of this same
-- `agno_wfm` instance (ADR-0108), not a new database, so this role's
-- existing grants below apply on the replica unmodified once Phase 2 wires
-- it up - and the MV refresh jobs' cross-schema *source* reads reuse
-- `agno_migrator` (ADR-0098's precedent), never a widened grant here.
CREATE ROLE agno_analytics_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 10 (AI Layer, Node/NestJS) - same shared-database, new-schema-
-- new-role pattern as Module 03/04/05/06/07/08/09, see docs/adr/0113. Owns
-- no operational data from any other module - every gRPC response it reads
-- is stored only as an `AIInteraction.input_context` audit/reproducibility
-- copy, never a live source another query reads from (§2).
CREATE ROLE agno_ai_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 11 (Mobile / Employee Self-Service, Node/NestJS) - same
-- shared-database, new-schema-new-role pattern as every prior module, see
-- docs/adr/0151. Owns only `OfflineActionQueue` (`mobile-ess-service`);
-- forwards clock_event actions through attendance-leave-service's own
-- HMAC-signed webhook ingestion (§2.2 rule 3, docs/adr/0152) rather than
-- reading/writing `attendance_leave.*` directly - this role gets no grant
-- on that schema.
CREATE ROLE agno_mobile_ess_app WITH LOGIN PASSWORD 'changeme_local_only';
-- Module 12 (Integration Hub, Node/NestJS) - same shared-database,
-- new-schema-new-role pattern as Module 03/04/05/06/07/08/09/10, see
-- docs/adr/0136. Holds references to every tenant's HRIS/payroll/ACD/CRM
-- credentials but never the credentials themselves (Vault-referenced only,
-- ADR-0134) - the schema/role boundary here is deliberately as tight as
-- every other module's, not widened for this module's larger external
-- attack surface.
CREATE ROLE agno_integration_hub_app WITH LOGIN PASSWORD 'changeme_local_only';

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION agno_migrator;
-- Module 02 (Org Structure/Employee/Skills/Calendar) - separate schema,
-- same two-role split, same bounded-context boundary as `core` (see
-- docs/adr/0008-org-unit-hierarchy-storage.md).
CREATE SCHEMA IF NOT EXISTS org AUTHORIZATION agno_migrator;
-- Module 03 - same database, new schema, new role (docs/adr/0017). Not a
-- separate Postgres database: see that ADR for why.
CREATE SCHEMA IF NOT EXISTS forecasting AUTHORIZATION agno_migrator;
-- Module 04 - same database, new schema, new role (docs/adr/0052).
CREATE SCHEMA IF NOT EXISTS scheduling AUTHORIZATION agno_migrator;
-- Module 05 - same database, new schema, new role (docs/adr/0066).
CREATE SCHEMA IF NOT EXISTS intraday AUTHORIZATION agno_migrator;
-- Module 06 - same database, new schema, new role (docs/adr/0073).
CREATE SCHEMA IF NOT EXISTS attendance_leave AUTHORIZATION agno_migrator;
-- Module 07 - same database, new schema, new role (docs/adr/0083).
CREATE SCHEMA IF NOT EXISTS marketplace AUTHORIZATION agno_migrator;
-- Module 08 - same database, new schema, new role (docs/adr/0093).
CREATE SCHEMA IF NOT EXISTS compliance AUTHORIZATION agno_migrator;
-- Module 09 - same database, two new schemas (own entities + own
-- materialized-view lineage/storage), new role (docs/adr/0108).
CREATE SCHEMA IF NOT EXISTS analytics AUTHORIZATION agno_migrator;
CREATE SCHEMA IF NOT EXISTS analytics_mv AUTHORIZATION agno_migrator;
-- Module 10 - same database, new schema, new role (docs/adr/0113).
CREATE SCHEMA IF NOT EXISTS ai_layer AUTHORIZATION agno_migrator;
-- Module 11 - same database, new schema, new role (docs/adr/0151).
CREATE SCHEMA IF NOT EXISTS mobile_ess AUTHORIZATION agno_migrator;
-- Module 12 - same database, new schema, new role (docs/adr/0136).
CREATE SCHEMA IF NOT EXISTS integration_hub AUTHORIZATION agno_migrator;

GRANT CONNECT ON DATABASE agno_wfm TO agno_migrator, agno_app, agno_forecasting_app, agno_scheduling_app, agno_intraday_app, agno_attendance_leave_app, agno_marketplace_app, agno_compliance_app, agno_analytics_app, agno_ai_app, agno_mobile_ess_app, agno_integration_hub_app;
-- Postgres 15+ no longer grants CREATE on a database (or on the `public`
-- schema) to PUBLIC by default, so a non-owner migration role needs both
-- explicitly: CREATE ON DATABASE for `CREATE SCHEMA core`/`CREATE SCHEMA org`/
-- `CREATE SCHEMA forecasting`/`CREATE SCHEMA scheduling`/`CREATE SCHEMA intraday`/
-- `CREATE SCHEMA attendance_leave`/`CREATE SCHEMA marketplace`/
-- `CREATE SCHEMA compliance`/`CREATE SCHEMA analytics`/
-- `CREATE SCHEMA analytics_mv`/`CREATE SCHEMA ai_layer`/`CREATE SCHEMA mobile_ess`/
-- `CREATE SCHEMA integration_hub`, CREATE ON SCHEMA public for
-- `CREATE EXTENSION ltree WITH SCHEMA public` (Module 02's Phase 1 migration).
GRANT CREATE ON DATABASE agno_wfm TO agno_migrator;
GRANT CREATE ON SCHEMA public TO agno_migrator;
GRANT USAGE ON SCHEMA core TO agno_app;
GRANT USAGE ON SCHEMA org TO agno_app;
-- agno_forecasting_app gets USAGE on `forecasting` only - not `core`, not
-- `org`. Module 03 talks to Module 02's data via EmployeeService/
-- CalendarService's gRPC contracts, never by reading org.* tables directly
-- (docs/module-03-phase-1-design-doc.md).
GRANT USAGE ON SCHEMA forecasting TO agno_forecasting_app;
-- agno_scheduling_app gets USAGE on `scheduling` only - not `core`, not
-- `org`, not `forecasting`. Module 04 talks to Module 01/02/03's data via
-- their gRPC contracts, never by reading another schema's tables directly
-- (docs/adr/0052, docs/module-04-phase-1-design-doc.md).
GRANT USAGE ON SCHEMA scheduling TO agno_scheduling_app;
-- agno_intraday_app gets USAGE on `intraday` only - not `core`, not `org`,
-- not `forecasting`, not `scheduling`. Module 05 talks to Module 04's data
-- via its REST/NATS contracts (ADR-0064), never by reading another
-- schema's tables directly (docs/adr/0066).
GRANT USAGE ON SCHEMA intraday TO agno_intraday_app;
-- agno_attendance_leave_app gets USAGE on `attendance_leave` only - not
-- `core`, not `org`, not `forecasting`, not `scheduling`, not `intraday`.
-- Module 06 talks to Module 02's org/policy data and Module 04's schedule
-- data via their own contracts, never by reading another schema's tables
-- directly (docs/adr/0073, docs/module-06-phase-1-design-doc.md).
GRANT USAGE ON SCHEMA attendance_leave TO agno_attendance_leave_app;
-- agno_marketplace_app gets USAGE on `marketplace` only - not `core`, not
-- `org`, not `scheduling`, not any other module's schema. Module 07 talks
-- to Module 02's employee/skill data and Module 04's schedule/constraint
-- data via their own gRPC contracts, never by reading another schema's
-- tables directly (docs/adr/0083, docs/adr/0082).
GRANT USAGE ON SCHEMA marketplace TO agno_marketplace_app;
-- agno_compliance_app gets USAGE on `compliance` only - not `core`, not
-- `org`, not `intraday`, not any other module's schema. Module 08 reads
-- Module 05's adherence rollup tables via a dedicated read-only connection
-- to intraday's own role/schema (ADR-0094), never by being granted access
-- to `intraday.*` itself, and talks to Module 02/04 exclusively via its own
-- gRPC contract (docs/adr/0093, docs/module-08-phase-1-design-doc.md).
GRANT USAGE ON SCHEMA compliance TO agno_compliance_app;
-- agno_analytics_app gets USAGE on `analytics`/`analytics_mv` only - not
-- `compliance`, not `forecasting`, not `org`, not any other module's
-- schema. Module 09 reads every other module's already-computed data via
-- `agno_migrator` against the analytics read replica (ADR-0108, ADR-0098's
-- precedent), never by being granted access to another module's schema
-- itself.
GRANT USAGE ON SCHEMA analytics TO agno_analytics_app;
GRANT USAGE ON SCHEMA analytics_mv TO agno_analytics_app;
-- agno_ai_app gets USAGE on `ai_layer` only - not `scheduling`, not
-- `forecasting`, not any other module's schema. Module 10 reads every
-- other module's structured data exclusively via gRPC (§1's mandated
-- stack; §5.1's tenant-scoping defense in depth depends on this being true)
-- and writes back through the owning module's own governed write API
-- (§3) - never by being granted access to another module's schema itself.
GRANT USAGE ON SCHEMA ai_layer TO agno_ai_app;
-- agno_mobile_ess_app gets USAGE on `mobile_ess` only - not `attendance_leave`,
-- not `core`, not any other module's schema. Module 11 forwards clock_event
-- actions to attendance-leave-service's own HMAC-signed ingestion endpoint
-- (docs/adr/0152), never by reading/writing `attendance_leave.*` directly.
GRANT USAGE ON SCHEMA mobile_ess TO agno_mobile_ess_app;
-- agno_integration_hub_app gets USAGE on `integration_hub` only - not
-- `org`, not `attendance_leave`, not `intraday`, not any other module's
-- schema. Module 12 talks to Module 02/05/06's data exclusively through
-- their own bulk-import/leave-attendance/activity-events contracts
-- (§0/§2.2 rule 3, ADR-0135, ADR-0136), never by reading another module's
-- schema directly.
GRANT USAGE ON SCHEMA integration_hub TO agno_integration_hub_app;

-- agno_app/agno_forecasting_app/agno_scheduling_app/agno_intraday_app/
-- agno_attendance_leave_app/agno_marketplace_app/agno_compliance_app/
-- agno_analytics_app/agno_ai_app/agno_integration_hub_app get table-level
-- grants per-table in the migrations themselves (see
-- 1700000000000-InitialSchema.ts,
-- 1700000001000-Module02OrgEmployeeSchema.ts,
-- forecasting-service/migrations/versions/0001_initial_schema.py,
-- scheduling-service/migrations/versions/0001_initial_schema.py,
-- intraday-service/src/database/migrations/*-InitialAdherenceSchema.ts,
-- attendance-leave-service/src/database/migrations/*-InitialAttendanceLeaveSchema.ts,
-- shift-marketplace-service/src/database/migrations/*-InitialMarketplaceSchema.ts,
-- adherence-compliance-service/src/database/migrations/*-InitialComplianceSchema.ts,
-- analytics-reporting-service/src/database/migrations/*-InitialAnalyticsSchema.ts,
-- ai-layer-service/src/database/migrations/*-InitialAiLayerSchema.ts,
-- mobile-ess-service/src/database/migrations/*-InitialMobileEssSchema.ts,
-- integration-hub-service/src/database/migrations/*-InitialIntegrationHubSchema.ts)
-- so that exceptions (audit_log, org_unit_history, employee_history,
-- compliance_report's DELETE grant, provider_rate_limit_config's SELECT-only
-- grant) are explicit and reviewable in the same file that creates the
-- table, rather than a blanket "GRANT ALL" here that a future migration
-- could silently widen.

ALTER ROLE agno_app SET search_path TO core, org, public;
ALTER ROLE agno_migrator SET search_path TO core, org, forecasting, scheduling, intraday, attendance_leave, marketplace, compliance, analytics, analytics_mv, ai_layer, mobile_ess, integration_hub, public;
ALTER ROLE agno_forecasting_app SET search_path TO forecasting, public;
ALTER ROLE agno_scheduling_app SET search_path TO scheduling, public;
ALTER ROLE agno_intraday_app SET search_path TO intraday, public;
ALTER ROLE agno_attendance_leave_app SET search_path TO attendance_leave, public;
ALTER ROLE agno_marketplace_app SET search_path TO marketplace, public;
ALTER ROLE agno_compliance_app SET search_path TO compliance, public;
ALTER ROLE agno_analytics_app SET search_path TO analytics, analytics_mv, public;
ALTER ROLE agno_ai_app SET search_path TO ai_layer, public;
ALTER ROLE agno_mobile_ess_app SET search_path TO mobile_ess, public;
ALTER ROLE agno_integration_hub_app SET search_path TO integration_hub, public;
