# ADR-0023: Phase 5 — Erlang C only (not X/A), a new `service_level_targets` table, and the shrinkage fallback chain

## Context
§7 names Phase 5 as "Erlang C/X headcount conversion... `required_headcount`
computation feeding off `predicted_volume`/`predicted_aht_seconds`/
`predicted_shrinkage_pct`." Turning that into real code surfaced two gaps
the source spec doesn't resolve: Erlang C needs a target service level and
answer-time threshold that exist nowhere in this schema, and
`predicted_shrinkage_pct` is `NULL` on every `ForecastDataPoint` a trained
model (SARIMA/Prophet/LightGBM) produces (ADR-0020/0021's `target_metric=
'volume'`-only discriminator convention) — only cold-start-seeded points
have it populated (averaged from donor queues' actuals).

## Decision 1: Erlang C only — Erlang X/A is a stated, not a silent, gap
"Erlang X" (also called Erlang A) extends Erlang C with customer
abandonment, which requires a mean patience/abandon-time parameter this
platform does not ingest or estimate anywhere — `historical_actuals` has no
abandonment column, and nothing computes one. Implementing Erlang X would
mean inventing an unvalidated patience assumption, which is exactly the
kind of unstated-methodology number §0 prohibits. Erlang C (no abandonment
modeling — every offered call is eventually answered) is implemented for
real; Erlang X/A stays a named future gap, not silently approximated.

## Decision 2: numerically stable Erlang C, via the standard Erlang-B recursion
Direct evaluation of `A^N / N!` overflows for realistic `N` (any contact
center with a few hundred agents). `app/ml/erlang.py` uses the standard
recursive Erlang-B formula (`B(0) = 1`, `B(k) = A·B(k-1) / (k + A·B(k-1))`)
and converts Erlang B → Erlang C via the standard identity
(`C(N) = B(N) / (1 - (A/N)·(1 - B(N)))`) — exact, `O(N)`, no factorials, no
overflow for any `N` this platform will ever compute. `service_level(N)`
then applies the standard Erlang C wait-time-distribution formula. Required
agents is the smallest integer `N` clearing *both* a target service level
(`P(wait ≤ target_answer_time) ≥ target_service_level`) and a max-occupancy
cap (`offered_load / N ≤ max_occupancy` — without this cap, a queue with
very high volume/short AHT can converge on an occupancy above 100%, which
Erlang C's own math never rules out but is not operationally meaningful).

## Decision 3: a new `service_level_targets` table, tenant-writable, with platform defaults
`forecasting.service_level_targets` (tenant_id + org_unit_id PK,
`target_service_level`, `target_answer_time_seconds`, `max_occupancy`) —
local to this schema, same "not solved by a cross-service call that doesn't
exist" posture as `queue_profiles`/`tenant_settings` (ADR-0020). Unlike
`tenant_settings` (entitlement flags, admin-only), this is ordinary business
configuration a tenant sets for itself — `agno_forecasting_app` gets
`SELECT, INSERT, UPDATE`, and `PUT /v1/forecasting/service-level-targets/
{orgUnitId}` is tenant-scoped, not gated. **Platform defaults apply when no
row exists** (80% service level, 20-second target answer time, 85% max
occupancy — the industry-conventional "80/20 rule" plus a standard
occupancy ceiling), so headcount computation works out of the box without
requiring every tenant to configure this before their first forecast.

## Decision 4: AHT and shrinkage fallback chains
Erlang C needs both AHT and a shrinkage estimate, and **neither is populated
on a model-fulfilled `ForecastDataPoint`** — ADR-0020/0021's `target_metric=
'volume'`-only discriminator convention means `predicted_aht_seconds`/
`predicted_shrinkage_pct` stay `NULL` on every row `inference_service`
writes; only cold-start-seeded points (donor-averaged) have both. Two
independent fallback chains, resolved once per run
(`headcount_service.build_headcount_context`), not once per interval:

- **Shrinkage**: (1) this interval's own `predicted_shrinkage_pct` if set,
  (2) the org unit's historical average `actual_shrinkage_pct` over the
  last 8 weeks, (3) a stated platform default, **30%** (a commonly-cited
  contact-center ballpark, not a tuned or validated number). Always
  resolves to *some* value — no silent zero-shrinkage assumption, which
  would understate headcount need in exactly the way §0 warns against.
- **AHT**: (1) this interval's own `predicted_aht_seconds` if set, (2) the
  org unit's historical average `actual_aht_seconds` over the last 8 weeks,
  (3) **`None` — `required_headcount` is left unset for that run rather than
  guessed.** Unlike shrinkage, AHT has no defensible universal fallback (a
  chat queue's AHT and a technical-support queue's AHT aren't remotely
  comparable) — inventing one would be exactly the unstated-methodology
  claim §0 prohibits, so this chain is allowed to terminate in "can't
  compute" rather than a number.

## Consequences
- `required_headcount` is now real and populated on every `ForecastDataPoint`
  this service writes (both the model-fulfilled and cold-start paths) —
  closing the one column Phase 1-4 always left `NULL`, and the actual thing
  Module 04 (Scheduling) consumes per §8's stated non-goal boundary
  ("Module 03 only supplies `required_headcount`... consumed by Module 04").
- `required_headcount` is a fractional (`numeric(10,2)`) value — the integer
  Erlang C agent count divided by `(1 - shrinkage)`, not rounded further.
  Rounding for actual scheduling is Module 04's decision, not this
  service's.
- Erlang C's search loop is capped at a sanity ceiling (10,000 agents) to
  guarantee termination on pathological input (e.g. a corrupted near-zero
  AHT) rather than looping indefinitely - raises rather than hangs.
- The shrinkage fallback's step 2 (historical average) means
  `required_headcount` for the *same* predicted volume/AHT can differ
  between two org units purely because of their different shrinkage
  history — expected and correct (shrinkage is genuinely a real, per-queue
  operational characteristic), but worth knowing when comparing headcount
  numbers across queues.
