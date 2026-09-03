# ADR-0034: Explicit Phase 3 scope deferrals

## Context
§5.1 lists LDAP/AD, Apple, GitHub Enterprise, and GitLab alongside SAML/OIDC
as protocols/vendors to support; §5.3 (via RFC 7644) defines SCIM Bulk
operations and a `/scim/v2/Schemas` discovery endpoint neither this ADR set
nor `ScimDiscoveryController` implements. Rather than silently omit these,
they're recorded here with the reasoning, matching this repo's established
practice (Phase 2's ADR-0026 on Device Authorization Flow) of naming what
was cut and why, not just what was built.

## Decisions (deferred, not built this phase)

1. **LDAP/AD direct-bind authentication.** Structurally a different protocol
   family from SAML/OIDC (a direct credential bind against a directory
   server, not a browser-redirect federation flow) - §8's Phase 3 bullet
   names "SAML 2.0, per-tenant TenantIdentityProvider config, SCIM 2.0,
   WebAuthn/Passkeys," not LDAP specifically. Would need an `ldapjs`-based
   connector and a `TenantIdentityProvider.protocol = 'ldap'` variant with
   its own field set (`ldap_url`, `ldap_bind_dn`, `ldap_search_base`, ...) -
   a reasonable near-term addition, not built here.
2. **Apple, GitHub Enterprise, GitLab as distinct integrations.** All three
   speak OAuth2/OIDC (Apple's "Sign in with Apple" is OIDC-compatible;
   GitHub/GitLab Enterprise expose OIDC or OAuth2 endpoints) and are
   reachable through `OidcFederationService`'s generic OIDC path by
   configuring a `TenantIdentityProvider` row with that vendor's discovery
   URL/client credentials - no vendor-specific code was written. Per-vendor
   quirks (Apple's JWT-signed, auto-rotating client secret being the most
   significant one) are not handled and would need a per-vendor adapter if
   exact compliance with that specific behavior is required.
3. **SCIM Bulk operations (RFC 7644 §3.7).** `ScimDiscoveryController`'s
   `ServiceProviderConfig` correctly advertises `bulk.supported: false` -
   this is not a silent gap, it's declared. Every mainstream SCIM connector
   falls back to individual per-resource requests when bulk isn't
   advertised, so this doesn't break provisioning, only makes very
   large initial syncs slower.
4. **`/scim/v2/Schemas` discovery endpoint.** `ServiceProviderConfig` and
   `ResourceTypes` are implemented (mainstream connector setup flows probe
   these before allowing a config to be saved); the full `Schemas` endpoint
   (a machine-readable description of every attribute this platform's User/
   Group resources support) is not. Less commonly hard-required by
   connector setup than the other two, but a real gap for a SCIM client
   that introspects schemas before mapping attributes.
5. **SAML Single Logout / OIDC RP-Initiated Logout.** See ADR-0031's
   consequences - the config fields exist, the flows don't.

## Consequences
Every item above is genuinely missing functionality, not a hidden
shortcut inside something that claims to be complete. Each is listed again
in `docs/phase-3-production-readiness-checklist.md` so it isn't lost between
this ADR and whoever picks up the next increment of work on this module.
