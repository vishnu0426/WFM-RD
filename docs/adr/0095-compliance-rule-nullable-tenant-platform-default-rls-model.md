# ADR-0095: `ComplianceRule`/`RetentionPolicy` use a nullable `tenant_id` for platform-default rows, with a split RLS policy

## Context
§2.2 rule 3 requires that `ComplianceRule.tenantId` be nullable, with `NULL`
meaning "platform-default rule for a jurisdiction" that a tenant-specific
row (non-null `tenantId`) for the same `jurisdiction`+`ruleType` overrides.
§5b's `RetentionPolicy` needs the identical shape ("tenant-configurable but
defaulting to the stricter known regulatory minimum per jurisdiction").
Every other table in this schema (and every table in every prior module's
schema, ADR-0002's convention) has a `NOT NULL tenant_id` and a uniform
`tenant_isolation` policy: `USING (tenant_id = current_tenant) WITH CHECK
(tenant_id = current_tenant)`. Applied unmodified to a nullable-`tenant_id`
table, that policy's `USING` clause would silently hide every
platform-default row from every tenant (`tenant_id = <this tenant>` never
matches `NULL`) - directly breaking §0.6's whole point, since Module 02/04
resolving "the legal floor" would see nothing until a tenant happened to
have its own override row.

A second, harder question this ADR also has to answer: if `WITH CHECK` is
loosened to allow a `NULL` tenant_id, *any* tenant's connection could write
a platform-default row visible to every other tenant - a materially
different blast radius than an ordinary tenant-scoped write, and not a
decision to make implicitly via a permissive RLS clause.

## Decision
Two tables (`compliance_rule`, `retention_policy`) get their own policy,
distinct from the uniform `tenant_isolation` policy every other table in
this schema uses:

```sql
CREATE POLICY tenant_isolation ON compliance.<table> FOR ALL
USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR tenant_id IS NULL)
WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

`USING` and `WITH CHECK` are asymmetric by design: a tenant connection can
always **read** the platform default alongside its own overrides (`OR
tenant_id IS NULL`), but can **never write** a `NULL`-tenant row itself -
`WITH CHECK` has no `IS NULL` branch. This makes "who can create a
platform-default rule" a question this migration deliberately does not
answer yet, rather than answering it wrong by default: no role reachable
through this RLS policy can insert one. Creating/updating a platform-default
`ComplianceRule`/`RetentionPolicy` row therefore requires either (a) a
future platform-admin concept with its own authz gate feeding into a
distinct write path (e.g. a `agno_migrator`-credentialed or otherwise
RLS-bypassing operation, gated by real authorization logic in application
code, not by RLS alone), or (b) an explicit decision that platform defaults
are seeded/maintained out of band (migration-time data, an internal
tooling path) rather than through the same `createComplianceRule` mutation
tenants use for their own overrides. Phase 2 (ComplianceRule CRUD) must
make this choice explicitly - this ADR only guarantees the schema doesn't
make it by accident.

Versioning uniqueness (§2.2 rule 3: "a tenant-specific row ... overrides the
platform default ... only in the stricter direction") is enforced via two
partial unique indexes rather than one plain composite unique constraint,
because Postgres treats every `NULL` as distinct from every other `NULL` in
a unique constraint - a plain `UNIQUE (tenant_id, jurisdiction, rule_type,
version)` would never actually catch two colliding platform-default
versions:

```sql
CREATE UNIQUE INDEX ... ON compliance.compliance_rule (jurisdiction, rule_type, version) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX ... ON compliance.compliance_rule (tenant_id, jurisdiction, rule_type, version) WHERE tenant_id IS NOT NULL;
```

The actual *stricter-than-the-floor* validation §0.6 requires
(`ValidatePolicyAgainstFloor`-shaped logic applied to a tenant's own
`ComplianceRule` override, per §2.2 rule 3's closing sentence) is
application logic, not something RLS or a `CHECK` constraint can express -
comparing two `jsonb` `definition` blobs for "is this at least as
protective" is domain logic belonging to Phase 2/4, not this migration.

## Consequences
- `compliance_rule`/`retention_policy` are the only two tables in this
  schema with a nullable `tenant_id` and a non-uniform RLS policy; every
  other table keeps the platform's ordinary `tenant_isolation` shape
  unchanged (ADR-0002).
- A normal tenant-scoped request (through `agno_compliance_app`, tenant
  context bound via the usual header-trust middleware) can read platform
  defaults today, even though nothing seeds any platform-default row in
  this phase. It structurally cannot create one - Phase 2 must decide and
  document who/what can, before `createComplianceRule` for a
  platform-default row is wired to anything.
- §2.2 rule 3's UI-facing requirement - "flag this as needing a human legal
  reviewer... regardless of automated validation passing" for a tenant
  adding jurisdiction nuance a platform default doesn't capture - is a
  Phase 2 UX/workflow decision layered on top of this schema, not something
  this migration enforces structurally (there is no schema-level way to
  force a human review step).
