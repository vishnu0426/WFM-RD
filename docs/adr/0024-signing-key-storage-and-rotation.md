# ADR-0024: Signing keys in Postgres, one active key + a retirement grace window

## Context
JWS-signed access/ID tokens (§3.4, §5.2) need an RSA keypair and a rotation story that
doesn't invalidate every outstanding token the instant a key is rotated - access
tokens can be up to 15 minutes old (§3.4), so a token signed one second before
rotation must still verify for up to that long afterward.

## Options considered
1. **A real KMS/HSM (AWS KMS, GCP Cloud KMS, HashiCorp Vault Transit)** - the correct
   production answer: private key material never leaves the KMS boundary, signing is
   an API call, not a local `crypto.sign`. Deferred: this is infra/credential-broker
   work (Terraform + Vault, per the production readiness checklist), not something a
   code-generation phase can stand up, and every other secret in this repo
   (`agno_app`'s DB password, etc.) has the same explicit "static placeholder for local
   dev" posture already (Phase 1's own README).
2. **Environment-variable-injected static keypair** - simpler, but makes rotation an
   infra deploy (restart every instance with a new env var) rather than an
   application-level operation, and gives every instance the exact same key with no
   audit trail of when it changed.
3. **`core.signing_keys` table** (chosen) - global reference data (no `tenant_id`, no
   RLS, same posture as `Permission` - see that entity's own doc comment), one row per
   key generation, `status` (`active`/`retired`) + `retired_at`. `SigningKeyService`
   bootstraps one on first boot if none exists (so `docker-compose up` + migrations is
   enough to get a working local dev environment) and exposes `rotate()` for a
   runbook-triggered rotation.

## Decision
Option 3, with a 30-minute post-retirement verification grace window
(`RETIRED_KEY_GRACE_PERIOD_MS`): `TokenService.verifyAccessToken` resolves the
verification key by the token's `kid` header, and `SigningKeyService.resolveVerificationKey`
accepts either the current active key or a retired key still inside that window. Once a
key falls outside the window, `GET /.well-known/jwks.json` (`SigningKeysRepository.findVerifiable`)
stops advertising it and verification of tokens signed with it starts failing - by
design, since 30 minutes safely exceeds the longest-lived access token (15 min) plus
clock-skew margin.

`uq_signing_keys_single_active` (a partial unique index on `status = 'active'`)
enforces at most one active key at the database level, not just by convention.

## Consequences
- **`private_key_pem` is a plaintext database column.** This is the single
  highest-leverage secret in the platform - whoever can read this table can forge a
  valid access token for any tenant. Explicitly flagged in the production readiness
  checklist as not production-ready; a real deployment needs this behind a KMS/HSM
  before go-live, not just before "someday."
- Key rotation is manual (`SigningKeyService.rotate()`, invoked via a runbook
  procedure - see docs/runbook.md), not scheduled. Automatic time-based rotation is
  reasonable future work once there's an operational signal (e.g. a suspected key
  compromise) driving urgency, rather than building a scheduler for a Phase 2 feature
  with exactly one caller so far.
- `agno_app` has `SELECT, INSERT, UPDATE` (no `DELETE`) on `signing_keys` - retired
  keys are kept, not deleted, so an incident investigation can always reconstruct
  which key signed a token found in a log at any point in the past.
