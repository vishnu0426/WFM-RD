# ADR-0029: `tenant_identity_providers` RLS is read-open, write-tenant-gated

## Context
Same structural problem ADR-0028 solved for `oauth_clients`: `SsoController`'s
`GET /v1/auth/sso/login/:tenantIdpId` and the shared `/v1/auth/sso/callback`
handler both resolve *which* `TenantIdentityProvider` a request is about via
this table's `id` - carried through the URL path on login, and through
SAML's RelayState / OIDC's `state` parameter on callback - before any tenant
context can possibly be bound. A closed `tenant_isolation` policy (§2.2's
default shape) would make the lookup that establishes the tenant fail
against itself.

## Decision
Identical shape to ADR-0028: `tenant_idp_select` is `USING (true)` (open),
while `_insert`/`_update`/`_delete` all require
`tenant_id = current_setting('app.current_tenant_id')`.
`TenantIdentityProvidersRepository` is not a `TenantScopedRepository`
subclass for the same reason `OAuthClientsRepository` isn't - `findById`
relies on the open policy and is callable with no tenant context bound;
every write path goes through `withTenantTransaction` and stays gated.

## Consequences
- Same disclosure profile ADR-0028 already accepted, extended to IdP
  federation metadata: any `agno_app` connection can read every tenant's
  `oidc_discovery_url`/`saml_sso_url`/`saml_entity_id`/`attribute_mapping` -
  not tenant business data, and not by itself sufficient to impersonate a
  login (that additionally requires either a valid assertion from the real
  IdP, or possession of `oidc_client_secret`, which is real secret material -
  see the next point).
- Unlike `oauth_clients.client_secret_hash` (a bcrypt hash, safe to store),
  `oidc_client_secret` is plaintext, needed in full to authenticate this
  platform to the external IdP's token endpoint. The open SELECT policy
  therefore means `oidc_client_secret`/`saml_certificate` are as exposed to
  any `agno_app` connection as any other column here - `SsoController`
  reads them internally; `TenantIdentityProvidersController`'s admin CRUD
  API (`TenantIdentityProviderView`) never returns `oidcClientSecret` in a
  response, the same redaction posture as `SigningKey.privateKeyPem`
  (ADR-0024). The database-level exposure itself is the same trade-off
  ADR-0024 already made and flagged for a real KMS/Vault-backed secret store
  before production.
