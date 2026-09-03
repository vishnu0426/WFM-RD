# ADR-0004: Denormalize `tenant_id` onto `role_permissions`, `user_roles`, `notification_preferences`

## Context
§2.1 doesn't list a `tenant_id` column on these three tables — they only carry
foreign keys to `roles`/`users`/`permissions`. But §2.2 rule 1 requires `tenant_id`
as the first column of every composite index "on every tenant-scoped table, no
exceptions," and requires RLS everywhere. Without a direct `tenant_id` column, RLS on
these tables would need an `EXISTS` subquery against the parent table
(`EXISTS (SELECT 1 FROM roles WHERE roles.id = role_permissions.role_id AND
roles.tenant_id = current_setting(...))`), which:
- can't be indexed the same way a direct equality predicate can (the planner has to
  execute the subplan, it doesn't get to push the parent's tenant index down for
  free in all query shapes), and
- is a second, easy-to-get-wrong copy of the same isolation logic per join table.

## Decision
Add `tenant_id uuid` to `role_permissions`, `user_roles`, and
`notification_preferences`. The enforcement mechanism differs by parent because
`roles.tenant_id` is nullable (global system roles) while `users.tenant_id` is not:

- **`user_roles`, `notification_preferences`** (parent is `users`, `tenant_id NOT
  NULL`): a genuine composite foreign key, `(tenant_id, user_id) REFERENCES
  users(tenant_id, id)`, backed by a `UNIQUE (tenant_id, id)` constraint on `users`.
  Since `users.tenant_id` is never null, Postgres's default `MATCH SIMPLE` FK
  semantics never take the "skip validation" branch — the FK is always checked.
- **`role_permissions`** (parent is `roles`, `tenant_id` nullable for system-global
  roles): a composite FK cannot be used safely here (see Consequences), so a
  `BEFORE INSERT OR UPDATE` trigger (`core.fn_sync_tenant_id_from_role`) looks up
  `roles.tenant_id` for the given `role_id` and overwrites whatever the caller
  supplied. This makes it impossible for `role_permissions.tenant_id` to drift from
  its parent role, including for global roles (`tenant_id` becomes `NULL`,
  correctly, without any special-casing by the caller).

## Consequences
- RLS policies on these three tables are a plain `tenant_id = current_setting(...)`
  (plus `OR tenant_id IS NULL` on `role_permissions` for global-role read access) —
  same shape, same index usage, as every other tenant-scoped table.
- The composite-FK path (`user_roles`, `notification_preferences`) is pure
  declarative DDL — no trigger, no application code, cannot be bypassed.
- The trigger path (`role_permissions`) was chosen over a composite FK because
  Postgres's default `MATCH SIMPLE` FK semantics skip validation entirely when any
  referencing column is `NULL` — a `role_permissions` row with `tenant_id = NULL`
  would silently stop validating `role_id` against `roles` at all under a naive
  composite FK. `MATCH FULL` was also rejected: it raises a constraint violation on
  any *mixed* null/non-null key, which would incorrectly reject the legitimate
  "tenant-scoped row referencing a global role" case (`role_permissions.tenant_id`
  set to the owning tenant, but `role_id` pointing at a `roles` row with
  `tenant_id IS NULL`) — a case this schema needs to allow. The trigger has neither
  failure mode: it always resolves the true `tenant_id` from `roles` directly.
