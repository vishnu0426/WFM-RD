# ACD On-Prem Collector

A standalone agent that runs **inside a customer's own network** to bridge
an on-premises ACD out to this platform, since `integration-hub-service`
(a shared, multi-tenant cloud service) cannot dial into a private network
sitting behind a customer's firewall.

Today this supports two on-prem input shapes:

1. **Avaya Aura Contact Center / CMS**, via its Application Enablement
   Services (AES) server, speaking CSTA-XML over a raw TCP socket per
   ECMA-323 Annex J.
2. **A customer's own message bus** (NATS) - for a customer whose
   ACD/contact-center stack already publishes agent-state events onto
   their own internal bus, rather than speaking a raw telephony protocol.
   See "Mode 2: subscribing to a customer's own NATS bus" below.

## Why this exists instead of a VPN or firewall rule

Outbound connections from inside a corporate network are almost always
permitted; inbound connections into one are almost always refused by
security teams. So instead of trying to reach into the customer's network
(VPN, site-to-site tunnel, opening a firewall port to AES), this collector
reaches *out*: it connects to AES locally (trivial - same network) and
makes one outbound HTTPS call per agent-state event to a public endpoint
this platform already exposes and already authenticates
(`intraday-service`'s `POST /v1/intraday/tenants/:tenantId/activity-events`,
HMAC-signed). No inbound port on the customer's side, ever.

## What it does

1. Opens a TCP connection to the customer's AES server (`AES_HOST`/`AES_PORT`).
2. Bootstraps the CSTA association (`RequestSystemStatus`) and starts
   monitoring each configured agent device (`MonitorStart` per
   `MONITORED_DEVICE_IDS`).
3. Translates the six real agent-state CSTA events (ready, not-ready, busy,
   working-after-call, logged-on, logged-off) into this platform's
   `ActivityEvent` shape.
4. Signs and forwards each event over outbound HTTPS to
   `intraday-service`'s ingestion endpoint, with automatic reconnect
   (exponential backoff) if the AES link drops, and a bounded, backpressure-
   aware retry queue if the ingestion endpoint is temporarily degraded.

Read-only, one direction only: **AES → this collector → our platform.**
Nothing is ever sent back to the ACD - no call routing, no state changes
initiated by this platform.

## Configuration

`ACD_SOURCE` selects which input adapter `main.ts` runs: `avaya-aura`
(default, so an existing deployment's env doesn't need to change) or
`nats-bus`. Both modes share the same three ingestion env vars
(`AGNO_TENANT_ID`/`AGNO_INGESTION_BASE_URL`/`AGNO_INGESTION_SECRET`) - only
the source-side config differs.

### Mode 1: Avaya Aura AES (`ACD_SOURCE=avaya-aura`)

| Variable | Required | Description |
|---|---|---|
| `AGNO_TENANT_ID` | yes | This platform's tenant id for the customer running this collector. |
| `AGNO_INGESTION_BASE_URL` | yes | Base URL of `intraday-service`'s public endpoint, e.g. `https://intraday.agno-wfm.example.com`. |
| `AGNO_INGESTION_SECRET` | yes | The HMAC signing secret issued for this tenant's ingestion credential (see "Getting an ingestion credential" below) - it is shown exactly once at creation time. |
| `AES_HOST` | yes | Hostname/IP of the customer's own AES server (reachable from wherever this collector runs). |
| `AES_PORT` | yes | AES's CSTA-XML TCP port. |
| `MONITORED_DEVICE_IDS` | yes | Comma-separated list of CSTA device IDs (agent extensions) to monitor. |
| `AES_SECURITY_TOKEN` | no | AES-specific credential, if your AES deployment requires one in the CSTA `security` extension field. Best-effort - see `src/avaya-aura-collector.ts`'s doc comment for why this hasn't been confirmed against a real AES instance. |

### Mode 2: subscribing to a customer's own NATS bus (`ACD_SOURCE=nats-bus`)

For a customer whose own ACD/contact-center stack already publishes
agent-state events onto their own NATS bus, rather than speaking CSTA to
an AES server. Implemented in `src/nats-bus-collector.ts` -
`src/nats-bus-event-mapper.ts` does the payload mapping.

| Variable | Required | Description |
|---|---|---|
| `AGNO_TENANT_ID` / `AGNO_INGESTION_BASE_URL` / `AGNO_INGESTION_SECRET` | yes | Same as Mode 1 - unchanged, this is still this platform's own tenant/ingestion identity, not the customer's bus. |
| `CUSTOMER_NATS_SERVERS` | yes | Comma-separated `host:port` (or `nats://`/`tls://`-prefixed) list for the **customer's own** NATS bus - not this platform's NATS. |
| `CUSTOMER_NATS_USER` / `CUSTOMER_NATS_PASS` | no | Username/password auth for the customer's bus, if it requires one. |
| `CUSTOMER_NATS_TLS_REJECT_UNAUTHORIZED` | no | Set to the literal string `false` to accept a self-signed/internal CA on the customer's bus without verification. Applied as `tls: { rejectUnauthorized: false }` on the connection - **not** Node's process-wide `NODE_TLS_REJECT_UNAUTHORIZED`, which the `nats` client library ignores for its own TLS socket (confirmed against a real customer bus). Defaults to verifying; a customer-supplied CA cert is the more correct fix and isn't plumbed through yet. |
| `CUSTOMER_NATS_MODE` | no | `core` (default) or `jetstream` - see below. Get this right before anything else: guessing `core` when the bus is actually JetStream-only means this collector connects successfully and silently receives nothing. |
| `CUSTOMER_NATS_FIELD_MAP` | yes | A JSON object describing how to read one of this platform's `ActivityEvent`s out of the customer's raw JSON payload - see below. |

**`CUSTOMER_NATS_MODE=core` (default) - flat pub/sub:**

| Variable | Required | Description |
|---|---|---|
| `CUSTOMER_NATS_SUBJECT` | yes | The subject or wildcard (e.g. `agent.state.>`) carrying agent-state events on the customer's bus. No default - get this from the customer, it's never the same as this platform's own `agno.intraday.*` subjects. |

**`CUSTOMER_NATS_MODE=jetstream` - events delivered through a JetStream stream, not broadcast on a plain subject:**

Confirmed against a real customer bus (2026-09) that this is a real,
common shape - not a hypothetical. Their agent-state events were only
reachable through a JetStream stream (`CC_ACD_ESL_STREAM`), pulled by
another one of their own systems via a named durable consumer
(`CC_ACD_ESL_VOICE`). A plain `connection.subscribe(subject)` never sees
JetStream-delivered messages at all - they don't arrive on the stream's
subject as a broadcast, only to consumers explicitly pulling from the
stream.

| Variable | Required | Description |
|---|---|---|
| `CUSTOMER_NATS_STREAM` | yes | The JetStream stream name (e.g. `CC_ACD_ESL_STREAM`). Get this from the customer or from a discovery listen (see "Extending this pattern further" below) - don't guess. |
| `CUSTOMER_NATS_CONSUMER_NAME` | no | Binds to an existing durable consumer by name instead of creating a private one - see below for when this is required. |
| `CUSTOMER_NATS_FILTER_SUBJECT` | no | Narrows consumption to a subject/wildcard within the stream, if it carries more than agent-state events. Ignored if `CUSTOMER_NATS_CONSUMER_NAME` is set. |
| `CUSTOMER_NATS_DELIVER_POLICY` | no | `new` (default), `all`, or `last`. `new` only delivers events from the moment this collector connects - it does not replay the stream's history. Ignored if `CUSTOMER_NATS_CONSUMER_NAME` is set. |

**Default (no `CUSTOMER_NATS_CONSUMER_NAME`):** this collector attaches
its **own private ordered consumer** (`js.consumers.get(stream, opts)`
with no consumer name) - it never binds to an existing named durable
consumer, even if you happen to know its name from discovery. This
matters: a durable pull consumer's messages are fanned out across every
puller bound to it, so binding to a name another system already owns
would silently steal a share of that system's events instead of getting
our own full copy of the stream. Verified end to end against a real
local JetStream setup with a pre-existing named durable consumer present
the whole time - see `test/nats-bus-collector.spec.ts`'s "jetstream
mode" suite and the note under "Real disclosed gap" below.

**`CUSTOMER_NATS_CONSUMER_NAME` (bind to an existing durable consumer):**
confirmed against a real customer bus (2026-09) that the default above
isn't always usable: their `app` credential could create/inspect a
private ordered consumer (the request succeeded), but pulling actual
messages from it hung indefinitely - NATS silently drops an unauthorized
pull request instead of returning an error, so a permissions gap looks
identical to a network hang until you know to suspect it. Their NATS
permissions evidently only allow pulling from consumer names they've
explicitly pre-authorized. The fix: ask the customer to create one
durable consumer **dedicated to this integration** (a new name, not the
one another of their systems already owns) and grant this credential
pull permission on it; then set `CUSTOMER_NATS_CONSUMER_NAME` to that
name. This collector then binds to it directly
(`js.consumers.get(stream, name)`) rather than creating anything.

`CUSTOMER_NATS_FIELD_MAP` shape (mirrors `integration-hub-service`'s own
`FieldMapping` entity: source field name -> target, plus a value-translation
table - so onboarding the *next* NATS-bus customer is a config change, not
new code, as long as their payload is flat JSON):

```json
{
  "employeeIdField": "agentId",
  "activityField": "state",
  "timestampField": "ts",
  "siteIdField": "site",
  "queueIdField": "queue",
  "activityValueMap": { "AVAILABLE": "ready", "AUX": "notReady", "ON_CALL": "busy" }
}
```

Only `employeeIdField` and `activityField` are required.
`employeeIdField`'s value must already align with this platform's
`employeeId` - there is no discovery/crosswalk call, the same
"already-aligned IDs" posture `MONITORED_DEVICE_IDS` and the cloud-side
adapters all take. `activityValueMap` is optional - an unmapped raw value
is forwarded as-is. `timestampField` accepts an ISO-8601 string or a
unix epoch number (seconds or milliseconds, auto-detected); omit it to use
this collector's own receipt time instead.

A customer whose payload isn't flat JSON (protobuf, XML, a delimited
string) needs a bespoke mapper instead of this generic one - the same way
Mode 1 has its own dedicated `csta-event-mapper.ts` for Avaya's wire
format rather than one mapper trying to cover every shape.

**Real disclosed gap**, same posture every adapter in this platform takes
about an integration it hasn't been run against a live customer yet: both
`core` and `jetstream` modes have been verified end to end against a real
local `nats-server`/JetStream setup (publish → consume → map →
HMAC-signed forward, all real code, no test doubles), and `jetstream`
mode was additionally verified to leave a pre-existing named durable
consumer completely untouched. Connection, TLS handshake, and JetStream
stream/consumer discovery have also been verified live against a real
customer's on-prem bus. What has **not** been verified: actually pulling
and forwarding a real event from that customer's real stream end to end -
the payload shape and subject/stream naming are 100% customer-specific
and only ever arrive via the env vars above; nothing here guesses at
them.

## Getting an ingestion credential

Issued per tenant via `intraday-service`'s self-service REST API
(`IngestionCredentialsService`/`IngestionCredentialsController`) - there is
no admin console UI for this yet, only the API:

```sh
curl -X POST https://intraday.agno-wfm.example.com/v1/intraday/ingestion-credentials \
  -H "Authorization: Bearer <tenant-admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"label": "Site A on-prem collector"}'
```

The response's `secret` field is the value for `AGNO_INGESTION_SECRET` -
returned exactly once; it is never retrievable again after this call (the
raw value is never stored, only a Vault reference). `GET` the same path to
list a tenant's credentials (without their secrets), and
`POST /v1/intraday/ingestion-credentials/:id/revoke` to revoke one.

**Rotating without downtime**: a tenant can hold more than one active
credential at once. Issue a new one, reconfigure this collector's
`AGNO_INGESTION_SECRET` and restart it, confirm events are flowing under
the new credential, *then* revoke the old one - no outage window.

## Running it

**Docker (recommended for a customer's own environment), Mode 1 (Avaya):**

```sh
docker build -t agno-acd-collector .
docker run --rm \
  -e ACD_SOURCE=avaya-aura \
  -e AGNO_TENANT_ID=... \
  -e AGNO_INGESTION_BASE_URL=https://intraday.agno-wfm.example.com \
  -e AGNO_INGESTION_SECRET=... \
  -e AES_HOST=aes.internal.example.com \
  -e AES_PORT=4721 \
  -e MONITORED_DEVICE_IDS=1001,1002,1003 \
  agno-acd-collector
```

**Docker, Mode 2, `core` (flat pub/sub):**

```sh
docker run --rm \
  -e ACD_SOURCE=nats-bus \
  -e AGNO_TENANT_ID=... \
  -e AGNO_INGESTION_BASE_URL=https://intraday.agno-wfm.example.com \
  -e AGNO_INGESTION_SECRET=... \
  -e CUSTOMER_NATS_SERVERS=nats://192.168.9.81:4222 \
  -e CUSTOMER_NATS_USER=app \
  -e CUSTOMER_NATS_PASS=... \
  -e CUSTOMER_NATS_SUBJECT='agent.state.>' \
  -e CUSTOMER_NATS_FIELD_MAP='{"employeeIdField":"agentId","activityField":"state"}' \
  agno-acd-collector
```

**Docker, Mode 2, `jetstream` (stream/consumer-based):**

```sh
docker run --rm \
  -e ACD_SOURCE=nats-bus \
  -e AGNO_TENANT_ID=... \
  -e AGNO_INGESTION_BASE_URL=https://intraday.agno-wfm.example.com \
  -e AGNO_INGESTION_SECRET=... \
  -e CUSTOMER_NATS_SERVERS=nats://192.168.9.81:4222 \
  -e CUSTOMER_NATS_USER=app \
  -e CUSTOMER_NATS_PASS=... \
  -e CUSTOMER_NATS_TLS_REJECT_UNAUTHORIZED=false \
  -e CUSTOMER_NATS_MODE=jetstream \
  -e CUSTOMER_NATS_STREAM=CC_ACD_ESL_STREAM \
  -e CUSTOMER_NATS_FIELD_MAP='{"employeeIdField":"agentId","activityField":"state","timestampField":"ts"}' \
  agno-acd-collector
```

**Locally, for development against a fixture/test AES or a local `nats-server`:**

```sh
npm install
npm run start:dev
```

## Testing

```sh
npm test
```

Mode 1 (Avaya) tests run against fixture/mocked TCP and HTTP endpoints, the
same posture `integration-hub-service`'s own cloud-side adapter tests
take - none of this has been verified against a real, licensed AES
instance. Treat the CSTA field mappings and the AES login/authorization
placement (`AES_SECURITY_TOKEN`) as best-effort until validated against a
real customer AES.

Mode 2 (NATS bus) unit tests (`test/nats-bus-config.spec.ts`,
`test/nats-bus-event-mapper.spec.ts`, `test/nats-bus-collector.spec.ts`) use
an injected fake `connect()`, the same posture `nats-bus-collector.ts`'s own
doc comment describes; the `jetstream`-mode tests additionally assert that
`js.consumers.get()` is called with no `name`/`durable_name`, so a future
change can't accidentally reintroduce a named-consumer collision. Both
`core` and `jetstream` modes have additionally been run, manually, end to
end against a real local `nats-server`/JetStream setup (real publish, real
consume, real field mapping, real HMAC-signed HTTP forward, no test
doubles) - `jetstream` mode's run included a pre-existing named durable
consumer on the same stream the whole time, confirmed untouched afterward.
This is proof the wiring works against the real `nats` client library and
JetStream API, not proof it matches any specific customer's actual bus,
subject/stream naming, or payload shape.

## What this does *not* solve

- Any other on-prem system (HRIS, SSO, CRM) - see the platform's own
  integration-hub-service docs for that. SAML-based SSO against an on-prem
  IdP already works without any collector (browser-mediated); OIDC against
  an on-prem-only IdP has the same reachability gap this package solves
  for ACD, unsolved as of this writing.
- Real-time queue-level metrics (volume, live service level) - this
  collector only carries agent-state events, the same scope the cloud-side
  adapter has. `QUEUE_METRICS_UPDATED` still needs its own source.
- Any other on-prem ACD vendor speaking its own raw telephony protocol
  (Cisco UCCE/UCCX, Genesys Engage/PureConnect, Mitel, etc.) - only Avaya
  Aura's CSTA-XML is implemented. A vendor whose *on-prem* system already
  publishes to a message bus is covered by Mode 2 regardless of vendor,
  since that mode has no Avaya-specific logic in it at all.
- A customer's NATS bus whose payload isn't flat JSON, or that needs real
  transformation logic beyond a field rename/value lookup (nested paths,
  computed fields, multiple message types on one subject) - Mode 2's
  generic mapper doesn't cover that; it would need its own bespoke mapper
  file, the same way Mode 1 has its own for Avaya's wire format.

## Extending this pattern further

The reusable half of this package is everything *except*
`avaya-aura-collector.ts`/`csta-event-mapper.ts`/`csta-xml-frame.ts` (Mode 1)
and `nats-bus-collector.ts`/`nats-bus-event-mapper.ts` (Mode 2):
`config.ts`/`nats-bus-config.ts`'s env-var contracts,
`activity-event-forwarder.ts`'s HMAC signing, and
`backpressure-queue.ts`'s retry/backoff all apply unchanged to any on-prem
source. Mode 2 itself is a worked example of the pattern this section used
to describe as unbuilt: a customer whose own stack already publishes
agent-state events onto an internal bus is a *simpler* case than Avaya
Aura, since there's no protocol-level bootstrap dance to reimplement - just
a subscriber plus a payload mapper, both of which stop at "I have a parsed
`ActivityEvent`" and hand off to the exact same forwarder Mode 1 uses.

A customer whose bus is something other than NATS (Kafka, RabbitMQ, ...)
needs a new subscriber file following `nats-bus-collector.ts`'s own shape
(swap the `nats` client for that bus's own), but can likely reuse
`nats-bus-event-mapper.ts`'s field-map approach unchanged, since that part
only cares about "a parsed JSON object," not the transport it arrived on.
What you need from that kind of customer either way: their bus's
connection details and auth, the subject/topic name(s) carrying
agent-state events, the payload schema (field names *and* their
state-value vocabulary - there is no pre-built dialect dictionary for an
unseen vendor; see `CUSTOMER_NATS_FIELD_MAP` above, or
`integration-hub-service`'s `FieldMappingsService` for how the cloud-side
adapters handle this for their own supported vendors), and how their
agent/queue identifiers map to this platform's employee/`cc_queues` ids.
