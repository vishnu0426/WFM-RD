# ADR-0046: Webhook subscriptions fan out from the existing outbox publisher, delivered via a durable, HMAC-signed queue

## Context
§3.2 names webhook signing secrets as part of Phase 6's REST surface
(`OAuthController.register`'s own forward-reference comment: "the same
posture §3.2 requires for webhook signing secrets"). Nothing before this
phase let an external system register a URL to receive this platform's
events over HTTP - `GET /v1/audit-log` and NATS (ADR-0039) are both
pull/subscribe models; a webhook is push.

## Decision
**Two new tables** (`core.webhook_subscriptions`, `core.webhook_deliveries`,
migration `1700000010000-Module01Phase6WebhookSchema`). A subscription
names a `url` and a `subscribedSubjects` list (currently limited to
`agno.core.audit.created.v1`/`agno.core.policy.changed.v1` - Module 02's
`org.*` subjects aren't wired to fan-out yet, an explicit scope cut, not an
oversight). `secret` is stored **plaintext**, not hashed - unlike a
password or OAuth client secret (verified by comparing a caller-presented
value against a one-way hash), this platform has to read the secret back
on every delivery to compute that delivery's HMAC. A production deployment
should encrypt this column at rest via a KMS-backed envelope scheme - the
same flagged gap ADR-0024 already carries for signing-key private key
storage, not solved differently here.

**Fan-out, not a new consumer**: `WebhookFanoutService.fanOut` is called
from `CoreOutboxPublisherService.drain`, immediately after a successful
NATS publish (`CoreOutboxPublisherService`'s updated doc comment) - not a
separate poll loop over `core.outbox_events`. This means webhook delivery
inherits the outbox's own "already publishing this event to NATS" cadence
for free, and a webhook subscriber's downtime can never block that NATS
publish (fan-out failures are caught and logged inside `fanOut` itself,
never propagated back to the publisher's own retry/DLQ bookkeeping).

**Delivery is a second durable queue** (`WebhookDeliveryDispatcherService`,
5-second tick - faster than the outbox's 10s, since a webhook subscriber is
an external integration actively waiting, not an internal audit pipeline),
structurally the same "durable staging table + cron drain + retry/DLQ"
shape as `core.pending_audit_events` (ADR-0042) and `core.outbox_events`
(ADR-0039) - the third application of this idiom in this module, at three
different points in the pipeline.

**Signing** follows Stripe's `t=<unix_ms>,v1=<hmac>` shape: the HMAC-SHA256
is computed over `${timestamp}.${rawBody}`, not the body alone, specifically
so a receiver can reject an old, replayed request by checking the
timestamp - a body-only HMAC would still verify on a byte-for-byte replay
sent days later.

## Consequences
- A subscription's `secret` is returned exactly once, in the `POST
  /v1/webhooks` response body - identical posture to `POST /oauth/register`'s
  `client_secret` (ADR-0026) - and is otherwise never readable again through
  any REST/GraphQL response (`WebhookSubscriptionView` omits it).
- Delivery is at-least-once, not exactly-once: a delivery that succeeds on
  the receiver's end but whose response is lost in transit (network
  partition after the receiver processed it) is retried, since this
  platform only knows "did I get a 2xx back," not "did the receiver already
  act on this." Receivers are expected to dedupe on `X-Agno-Webhook-Id`
  (delivered as a header on every attempt, stable across retries of the
  same delivery row) - not yet documented anywhere consumer-facing, since
  there is no consumer-facing API doc surface in this repo yet (Phase 6
  readiness checklist).
- No delivery ordering guarantee across subscriptions or events - each
  delivery row is dispatched independently by whichever dispatcher tick
  picks it up; a receiver that needs ordering must derive it from the
  event payload's own timestamp/sequence fields, not delivery arrival order.
- Module 02's `org.*` events (`EmployeeChanged`, `SkillExpiring`) are not
  fan-out-eligible this phase - Module 02's own `OutboxPublisherService`
  (`src/modules/eventing`) was deliberately not touched, to avoid modifying
  Module 02's already-tested outbox code for a Module 01 feature (the same
  "don't touch the other module's tested code" conservatism ADR-0039
  already applied to `NatsClientService`).
