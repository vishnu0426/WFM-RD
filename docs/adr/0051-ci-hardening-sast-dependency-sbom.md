# ADR-0051: CI dependency-vulnerability gate is scoped to `critical` only; SAST and SBOM generation are real, running, non-blocking additions

## Context
The Phase 1 production readiness checklist named this gap explicitly:
"SAST / dependency scanning / SBOM / provenance attestation... `ci.yml`
runs lint, type-check, tests, and a secret scanner (gitleaks) - it does not
yet run Semgrep/CodeQL, `npm audit`-equivalent gating, or generate an SBOM.
Flagged for Phase 6/7 when there's a deployable artifact to attest."

## Decision
**SAST**: `.github/workflows/codeql.yml`, a separate workflow (CodeQL's
own action manages its own initialize/analyze steps and doesn't fit
`ci.yml`'s single build-and-test job), running on every PR/push to `main`
plus a weekly Monday scan (catches newly-published CVEs against unchanged
code, not just newly-introduced patterns in a given diff).

**Dependency vulnerability gate**: `npm audit --audit-level=critical` as a
blocking `ci.yml` step, plus `npm audit --audit-level=high` as a second,
explicitly non-blocking (`|| true`) informational step. **Not** gated at
`high` or `moderate`: running `npm audit` against this repo's current
dependency tree (including the OpenTelemetry/`prom-client` packages this
same phase added) surfaces 37 pre-existing findings (3 low, 22 moderate,
12 high, 0 critical) - all in transitive dependencies of
`@nestjs/platform-express`, `@nestjs/graphql`, `@nestjs/cli`, and
`testcontainers` (Express's `qs`/`multer`, `ws`, `uuid`, `tmp`/`inquirer`,
`webpack`, `undici`), every one of which `npm audit fix --force` reports
would require a breaking major-version upgrade of the owning `@nestjs/*`
package. Silently force-upgrading four core framework dependencies inside
an unrelated CI-hardening change, with no re-test pass against the actual
breaking changes involved, is a materially riskier move than the
vulnerabilities themselves currently pose in this pre-production repo -
so the gate is set where it's real (0 critical today, so it isn't a
no-op) rather than where it would immediately go red for issues this PR
didn't cause and can't respons­ibly fix as a side effect.

**SBOM**: `npx @cyclonedx/cyclonedx-npm` generates a CycloneDX-format SBOM
from `package-lock.json` (source-accurate - reflects what the manifest
actually resolves to, not a snapshot of whatever happens to be physically
present in `node_modules` at CI time), uploaded as a 90-day build artifact
on every CI run. The Phase 1 checklist's own phrasing - "when there's a
deployable artifact to attest" - presupposes a container image or similar
build output; this repo still doesn't have one (no `Dockerfile`/image
build exists anywhere). This SBOM describes the *application dependency
tree*, which is real and useful on its own (answers "are we running a
vulnerable version of X" instantly against any future advisory) - full
provenance attestation (SLSA, image signing) remains blocked on a
deployable-artifact build existing at all, unchanged from the original
checklist's own framing.

## Consequences
- The `critical`-only gate is deliberately conservative today. Ratcheting
  it to `high` (or `moderate`) is real, valuable follow-up work - but it
  is its own remediation project (triage each of the 22+12 findings,
  upgrade the owning packages, re-run the full test suite against each
  breaking change), not something to bundle silently into the PR that
  first wires the gate up. Tracked explicitly in the Phase 7 readiness
  checklist so it isn't lost.
- CodeQL's weekly schedule scan is the only mechanism in this repo that
  can surface a problem with *unchanged* code (a new CVE published against
  a dependency or pattern already merged) - every other CI gate here only
  runs against a diff.
- The SBOM artifact has no consumer yet (no dependency-track/Grype/Trivy
  ingestion pipeline reads it) - it exists and is correct, but "generate
  it" and "act on it automatically" are two different pieces of work, and
  only the first is done here.
- `npm audit`'s output is inherently a moving target (new advisories
  publish continuously against unchanged `package-lock.json` contents) -
  a green CI run today is not a permanent guarantee; this is a property of
  `npm audit` itself, not something this ADR's gate placement changes.
