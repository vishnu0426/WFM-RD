# ADR-0028: `oauth_clients` RLS is read-open, write-tenant-gated

## Context
§2.2 rule 1 requires RLS on every tenant-scoped table, closed by default (§2.2's
`tenant_isolation` policy shape: `USING (tenant_id = current_setting(...))`). But
`client_id` is exactly the value `POST /oauth/token` and `POST /oauth/authorize` use to
*resolve* which tenant a request belongs to - at that point in the request, no tenant
context can possibly be bound yet, so the closed policy would make every token
exchange fail closed against its own client lookup.

## Decision
Same shape Phase 1 already established for `roles`/`role_permissions` (system-global
rows readable by every tenant, writes tenant-gated): `oauth_clients_select` is
`USING (true)` (open), while `oauth_clients_insert`/`_update`/`_delete` all require
`tenant_id = current_setting('app.current_tenant_id')`. `OAuthClientsRepository` is
deliberately **not** a `TenantScopedRepository` subclass (unlike every other Phase 2
repository) - its read path (`findByClientId`) relies on this open policy and must be
callable with no tenant context bound at all; its write paths (`create`,
`findByTenantAndId`, `findAllForTenant`) go through `withTenantTransaction` exactly
like `TenantScopedRepository` would, so writes stay tenant-gated.

## Consequences
- Any authenticated `agno_app` connection can `SELECT * FROM core.oauth_clients` and
  see every tenant's registered clients (client_id, name, redirect_uris, allowed grant
  types) - not their secrets (`client_secret_hash` is bcrypt-hashed and provides no
  advantage to an attacker without the plaintext) and not tenant business data. This
  is the same disclosure profile Phase 1 already accepted for `roles`/
  `role_permissions`, applied consistently rather than invented fresh for this table.
- A row's `client_id` (not its `id`) is the actual routing key and is a
  database-level-unique, indexed column (`uq_oauth_clients_client_id`) - two tenants
  can never register colliding `client_id` values, which matters precisely because the
  lookup is tenant-blind by design.
- `migration-lint.ts`'s "tenant_id-first composite index" check still applies to
  `oauth_clients` (it has a `tenant_id` column and belongs in
  `TENANT_ID_COLUMN_TABLES`) - this ADR only changes the RLS *policy shape*, not the
  indexing rule.
