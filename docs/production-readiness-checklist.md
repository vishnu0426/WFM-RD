# Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5).

## Delivered in this phase (application code)

- [x] Full DDL for every §2 entity, with `up`/`down` migrations.
- [x] Row Level Security on every tenant-scoped table (`users`, `roles`,
      `role_permissions`, `user_roles`, `policies`, `audit_log`,
      `notification_preferences`).
- [x] Two-role DB credential split (`agno_migrator` vs `agno_app`);
      `agno_app` has no `UPDATE`/`DELETE` grant on `audit_log`.
- [x] DB-level `CHECK` constraint requiring `ai_rationale` for
      `actor_type = 'ai_agent'` rows.
- [x] Application-layer tenant guard (`TenantScopedRepository`,
      `TenantContextService`) that fails closed with no bound tenant context.
- [x] `audit_log` partitioned by month (local-dev bootstrap partitions only).
- [x] Automated CI check (`npm run migration:lint`) asserting RLS is enabled
      and every composite index is `tenant_id`-first, on every tenant-scoped
      table - a database-fact check, not a code-review-time convention.
- [x] Seed script for local dev (`npm run seed`).
- [x] Unit tests (tenant context guard) + integration tests (RLS + guard,
      running against a real Postgres).

## Explicitly NOT done here (needs a different owner before go-live)

- [ ] **Terraform for real Postgres provisioning** (RDS/Cloud SQL, PITR,
      read replicas, PgBouncer connection pooling, Multi-AZ). `docker-compose.yml`
      is local-dev only and is not a substitute for this.
- [ ] **Vault (or equivalent) for credential issuance.** `agno_migrator`/
      `agno_app` passwords are static placeholders in `.env.example` for local
      dev; production needs short-lived, rotated, dynamically-issued
      credentials, never a checked-in static password.
- [ ] **`pg_partman` (or equivalent) for `audit_log` partition rotation.**
      This migration creates four fixed local-dev partitions; nothing creates
      next month's partition automatically. Inserts into an unprovisioned
      month fail closed (by design, see ADR-0005) rather than silently
      falling into a catch-all - but someone has to own not letting that
      happen, and that's an ops/pager concern, not code in this repo.
- [ ] **Load testing.** No load test exists yet. §0.5's "100k+ concurrent
      sessions, 100k+ RPS platform-wide" capacity targets are stated in the
      Module prompt, not validated against this schema's actual index/lock
      behavior under concurrency - that requires a real load-testing pass
      once Phase 6 gives it something to point requests at.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** This code
      implements defense-in-depth tenant isolation and an append-only audit
      trail; it does not constitute a completed security audit or compliance
      program. Explicit non-goal (see §9 of the source spec).
- [ ] **SAST / dependency scanning / SBOM / provenance attestation.**
      `ci.yml` runs lint, type-check, tests, and a secret scanner
      (gitleaks) - it does not yet run Semgrep/CodeQL, `npm audit`-equivalent
      gating, or generate an SBOM. Flagged for Phase 6/7 when there's a
      deployable artifact to attest.
- [ ] **A migration linter enforcing "every tenant-scoped repository extends
      TenantScopedRepository."** `migration-lint.ts` checks the database
      side (RLS + index ordering); a custom ESLint rule checking the
      application side (no bare `Repository<T>` injected for a tenant-scoped
      entity outside the two intentional exemptions) does not exist yet.
- [x] ~~Tenant table authorization model~~ — fixed: `core.tenants` is now
      RLS-protected (self + direct BPO children + `app.is_platform_admin`
      escape hatch, ADR-0007), on the same two-GUC mechanism as every other
      table. What's still missing is Phase 2/6's job, not this phase's: only
      a validated JWT's `platform_admin` role claim may ever set
      `app.is_platform_admin` - there is no JWT validation yet to do that
      validating, so nothing can legitimately set the flag to `true` in a
      real request path until Phase 2 lands. The DB-side contract is done;
      the trustworthy caller isn't built yet.
