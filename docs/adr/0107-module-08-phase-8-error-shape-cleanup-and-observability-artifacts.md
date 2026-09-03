# ADR-0107: Phase 8 error-shape cleanup, and why no new Prometheus alerting rules or GraphQL read queries were added

## Context
Phase 8 is Module 08's last phase - "observability/hardening" per §7's own
build-phase list. Three real decisions, each about what to *not* build as
much as what to build:

1. **Two disclosed "surfaces as a generic 500" polish gaps** have sat
   unfixed since the phases that introduced them:
   `ComplianceGrpcClientUnavailableError` (root, ADR-0101, Phase 4) and
   `ScheduleQueryGrpcClientUnavailableError` (Module 08, ADR-0103, Phase 5).
   Both were plain `Error` subclasses instead of `DomainError` subclasses -
   correct fail-closed *behavior*, wrong error *shape* at the REST/GraphQL
   boundary. Cheap, low-risk, and repeatedly flagged - the natural thing a
   hardening phase closes.
2. **No Prometheus alerting rule exists anywhere in this platform** -
   confirmed by checking `observability/prometheus.yml` and every sibling
   module's own Phase 8 work. Every prior phase's checklist that flagged
   "no alerting on metric X" was describing a platform-wide absence, not a
   Module-08-specific gap.
3. **`AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord` have no GraphQL
   (or REST) read query anywhere** - true since Phase 1, explicitly
   deferred as "introduced alongside whichever phase first needs it,"
   and no phase ever needed it (§0.6's cross-module reconciliation only
   ever needed `ComplianceRule`, which Phase 2/4 already expose).

## Decision

**Fix both error-shape gaps for real** - `ComplianceGrpcClientUnavailableError`
now extends root's `DomainError` (`code: COMPLIANCE_SERVICE_UNAVAILABLE`,
mapped to `503` in root's `STATUS_BY_CODE`); `ScheduleQueryGrpcClientUnavailableError`
now extends Module 08's `DomainError` (`code: SCHEDULE_QUERY_SERVICE_UNAVAILABLE`,
mapped to `503` in Module 08's `STATUS_BY_ERROR`, alongside
`ImpactPreviewRequiredError`, itself never registered on the REST path
since Phase 5 - added now too, for completeness, even though neither is
currently reachable via a REST-only code path). Neither call site catches
either error specially, so this changes only the error's *shape*
(a typed code instead of a generic 500), never the fail-closed behavior
itself. Module 08's `DomainErrorFilter` gets its first-ever dedicated unit
test (13 cases, one per registered mapping plus the unregistered-fallback
and GraphQL-bailout paths) - it had none before, across 7 phases of real
E2E curl-verified but never unit-tested behavior.

**No new Prometheus alerting rules.** Every sibling module's own Phase 8
(04/05/06/07) built dashboards and runbooks but never alerting
infrastructure - there is no `rule_files`/`alerting` block in
`prometheus.yml`, no Alertmanager container, no `observability/alerts/`
directory anywhere in this platform. Introducing one for Module 08 alone
would be inconsistent with every sibling module's own closing phase, not
"catching up" to a missed convention - matching that precedent, this
phase does not add one either. The dashboard and runbook still document,
in prose, what a human should watch for and how to check it manually -
the same posture every sibling module's own Phase 8 artifacts take.

**No new GraphQL/REST read queries for `AdherenceScore`/`OccupancyRecord`/
`ShrinkageRecord`.** Checked every sibling module's own Phase 8 for a
precedent of closing a "we compute this data but nothing can read it back"
gap in the hardening phase specifically - none exists (Module 06's own
Phase 8 doc explicitly notes its GraphQL surface was "never triggered by
any of the 8 phases" as a standing note, not something it then fixed).
This is a real, disclosed, still-open gap - but building a new read API
in the platform's designated hardening phase, with no precedent for doing
so and no §0.6 integration point that ever needed it, would be scope
invention rather than hardening. Left explicitly open in this phase's own
production readiness checklist instead.

## Consequences
- Root and Module 08 both gain one newly-typed error code each
  (`COMPLIANCE_SERVICE_UNAVAILABLE`, `SCHEDULE_QUERY_SERVICE_UNAVAILABLE`) -
  any caller currently pattern-matching on the old generic 500/`INTERNAL_SERVER_ERROR`
  shape for either case (none exists today, per a repo-wide check before
  this change) would need to switch to the new code. No such caller
  exists, so this is a pure improvement with zero migration cost.
- The observability story for Module 08 remains "dashboard + runbook +
  manual `/metrics` checks," identical in kind to every sibling module -
  no automated paging exists for any SLO in this platform yet, Module 08
  included.
- `AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord` remain write-only
  from any external caller's perspective at the close of this module's
  8-phase build - a real, load-bearing, disclosed gap for any future
  phase or module that wants to build a supervisor-facing dashboard on
  top of this data.
