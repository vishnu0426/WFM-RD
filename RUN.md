# Running Agno WFM locally

Agno WFM is a polyglot platform: one modular-monolith root service (Node/NestJS,
Modules 01+02), 8 more independently-deployable Node/NestJS services, 2
Python/FastAPI services, a React web console, and an Expo mobile app — all
sharing one PostgreSQL database (one schema + one DB role per service), plus
Redis and NATS JetStream.

This guide is written for **local development without Docker** (verified
against Homebrew-installed Postgres/Redis/NATS). If you have Docker available,
each service's own `docker-compose up -d` does the equivalent for that service
alone — see each service's own README.

> **Want the one-command version?** After completing steps 1–2 below once,
> `./dev.sh start` runs the setup + start-up for every service in this guide
> in one shot (each service's own `.env`/dependency install/migrations are
> handled automatically, idempotently). `./dev.sh status` / `./dev.sh logs
> <name>` / `./dev.sh stop` manage it from there — see the script's own
> header comment for the full command list. The steps below are what it's
> actually running, useful for understanding what's happening or debugging
> one service in isolation.

## 1. Prerequisites

```bash
brew install postgresql@17 redis nats-server node python@3.12
brew services start postgresql@17
brew services start redis
```

- **Node** 20+ (all 9 NestJS services + web-console + mobile-app)
- **Python** 3.11 or 3.12 (forecasting-service, scheduling-service — 3.12 is
  what's actually verified working in this environment; no 3.13/3.14 wheel
  exists yet for some of forecasting-service's ML dependencies)
- **NATS JetStream** is not a `brew services` daemon — start it directly in
  its own terminal (or background it) whenever you need real event flows:
  ```bash
  nats-server -js
  ```
  Every service connects to NATS **lazily** — they all boot and serve most
  endpoints fine with NATS down; only actual event publish/consume paths
  (outbox delivery, marketplace claims, notifications, cross-service
  handoffs) need it running.

Create the shared database once:

```bash
createdb agno_wfm
```

## 2. Bootstrap DB roles & schemas (once, on a fresh database)

One shared script provisions every service's own Postgres role, schema, and
grants — **not idempotent** (plain `CREATE ROLE`, no `IF NOT EXISTS`), so run
it exactly once against a fresh `agno_wfm` database:

```bash
psql -d agno_wfm -f scripts/init-roles.sql
```

This creates `agno_migrator` (DDL owner, used only by each service's own
migration runner) plus one runtime role per service (`agno_app`,
`agno_forecasting_app`, `agno_scheduling_app`, `agno_intraday_app`,
`agno_attendance_leave_app`, `agno_marketplace_app`, `agno_compliance_app`,
`agno_analytics_app`, `agno_ai_app`, `agno_mobile_ess_app`,
`agno_integration_hub_app`) and their schemas. Every password in this script
is `changeme_local_only` — matches every service's own `.env.example`.

## 3. The root service (Modules 01+02 — Platform Core, Multi-Tenancy, Org/Employee)

Start this first — every other Node service's JWT verification and several
gRPC calls depend on it running.

```bash
npm ci
cp .env.example .env
npm run migration:run           # applies src/database/migrations
npm run nats:provision-streams  # requires nats-server -js already running
npm run seed                    # optional — demo tenant + OAuth client + admin user/password
npm run start:dev
```

Runs on **http://localhost:3000** — REST under `/v1/*` and `/oauth/*`,
GraphQL at `/graphql`, gRPC on `:5000`, JWKS at
`/.well-known/jwks.json`, health at `/healthz`/`/readyz`, metrics at
`/metrics`.

`npm run seed` is the fastest way to get a working login — it prints a
demo tenant admin's email/password and a registered OAuth client id to the
console when it finishes.

## 4. The other 8 Node/NestJS services

Each one is independent — same recipe for all of them, different port/DB
role per service (each has its own `.env.example` with the right values
pre-filled):

```bash
cd <service-dir>
npm ci
cp .env.example .env
npm run migration:run
npm run start:dev
```

| Service | Module | Port |
|---|---|---|
| `intraday-service` | 05 — Intraday/Real-Time | 8200 |
| `attendance-leave-service` | 06 — Attendance & Leave | 8300 |
| `shift-marketplace-service` | 07 — Shift Marketplace | 8400 |
| `adherence-compliance-service` | 08 — Adherence & Compliance | 8500 |
| `analytics-reporting-service` | 09 — Analytics & Reporting | 8600 |
| `ai-layer-service` | 10 — AI Layer | 8700 |
| `mobile-ess-service` | 11 — Mobile/ESS backend | 8800 |
| `integration-hub-service` | 12 — Integration Hub | 8900 |

`intraday-service`, `attendance-leave-service`, `shift-marketplace-service`,
`ai-layer-service`, and `mobile-ess-service` all publish/consume real NATS
events — start `nats-server -js` before these if you want event-driven
features (notifications, marketplace claims, live adherence) to actually
flow. `attendance-leave-service`/`intraday-service`/`shift-marketplace-service`
also use Redis (already running via `brew services start redis`).

You don't need all 8 running to work on any one of them — each boots and
serves its own endpoints independently; only cross-service gRPC calls
(e.g. scheduling-service resolving an employee's leave) fail closed if the
callee isn't up.

## 5. The 2 Python services (Modules 03+04 — Forecasting & Scheduling)

Both need a real `Authorization: Bearer <JWT>` on every request as of this
session's JWT-verification fix (GAP-08) — the root service must be running
first so its JWKS endpoint (`http://localhost:3000/.well-known/jwks.json`)
is reachable.

### forecasting-service (port 8000)

```bash
cd forecasting-service
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

### scheduling-service (port 8100)

```bash
cd scheduling-service
python3.12 -m venv .venv && source .venv/bin/activate
```

**Known issue, install in this order — a plain `pip install -e ".[dev]"`
fails with `ResolutionImpossible`.** This project pins
`protobuf>=7.35,<8.0` (needed by generated gRPC code) but `ortools`'s own
declared metadata caps protobuf below that on every version up to and
including the latest (9.15) — a documented, verified-safe override (see
`pyproject.toml`'s own comment): CP-SAT genuinely works fine at runtime
against protobuf 7.35, ortools' own upper bound is just conservative. Work
around pip's strict resolver by installing `ortools` unpinned-by-pip last:

```bash
pip install -e ".[dev]" --no-deps
pip install fastapi "uvicorn[standard]" "sqlalchemy[asyncio]" asyncpg alembic \
  psycopg2-binary pydantic pydantic-settings "pyjwt[crypto]" nats-py \
  prometheus-client grpcio "protobuf>=7.35,<8.0" pytest pytest-asyncio httpx \
  ruff mypy "grpcio-tools>=1.82,<2.0" types-protobuf types-grpcio \
  numpy pandas immutabledict absl-py
pip install ortools --no-deps
```

Then:

```bash
cp .env.example .env
alembic upgrade head
uvicorn app.main:app --reload --port 8100   # API process — enqueues jobs only
python -m app.worker                        # separate process — does the actual CP-SAT solving
```

**Both processes are required** — `POST /v1/scheduling/jobs` returns
`status: queued` immediately; nothing ever solves without at least one
`python -m app.worker` also running against the same database. Run it in a
second terminal.

## 6. web-console (React, port 5173)

```bash
cd web-console
npm ci
cp .env.example .env
npm run dev
```

Talks directly to each backend service on its own port (not proxied through
Envoy) — `VITE_API_BASE_URL` (root, :3000), `VITE_FORECASTING_API_BASE_URL`
(:8000), `VITE_SCHEDULING_API_BASE_URL` (:8100),
`VITE_AI_LAYER_API_BASE_URL` (:8700) — all pre-filled correctly in
`.env.example` for this local setup. Log in with the credentials
`npm run seed` printed in step 3.

## 6b. frontend (static User Management console, no build step)

```bash
npx serve -l 5173 frontend        # or: python3 -m http.server 5173 --directory frontend
```

Native ES modules under `frontend/src/` (`app/` = shell/login/event wiring,
`core/` = API client + DOM helpers, `modules/identity-org/` = the 12
User-Management screens this console implements today, one folder per
service module, plus a stub `modules/<service>/` folder for each of the
other 11 backend services — see each stub's own `api.js`), loaded via
`<script type="module" src="./src/app/main.js">` in `frontend/index.html`.
Talks directly to the root service (`:3000`), `attendance-leave-service`
(`:8300`), and `scheduling-service` (`:8100`) via plain `fetch()` — see
`frontend/src/core/api.js` and the `window.WFM_CONFIG` block at the top of
`frontend/index.html` if any of those run on non-default ports. Must be
served on **port 5173** (or whatever `CORS_ORIGIN` is set to on the root
service — see `src/main.ts`) since the root service's CORS allowlist is a
fixed origin list, not a wildcard.

Log in with the demo tenant admin `npm run seed` prints:
`admin@acme-demo.example` / `ChangeMe123!`.

The Profiles screen's employee "Workforce / Agent" tab also calls
`integration-hub-service` (`:8900`) for its Data Source picker (live ACD
connector list — `GraphQL { connectors }`, filtered to `connectorType: ACD`).
That service needs to be running for real suggestions to appear (see its own
section below); if it isn't, the field falls back to free text with no error.

## 7. mobile-app (Expo)

```bash
cd mobile-app
npm ci
cp .env.example .env
npm run start        # then press `i` (iOS simulator), `a` (Android), or `w` (web)
```

Talks to **six** backends directly (all pre-filled in `.env.example`, all
default local ports): the root service for auth (:3000), scheduling-service
(:8100), mobile-ess-service (:8800, clock-in/out + offline sync forwarding),
intraday-service (:8200, live adherence), adherence-compliance-service
(:8500, adherence %), and attendance-leave-service (:8300, hours/leave
balance). Start whichever of those back the screen you're working on — the
app doesn't need all six for every feature, but clock-in/out and the
Adherence/Hours tabs each need their own specific service up.

## 8. Smoke test

```bash
curl http://localhost:3000/healthz          # root service
curl http://localhost:8000/healthz          # forecasting-service
curl http://localhost:8100/healthz          # scheduling-service
curl http://localhost:8200/healthz          # intraday-service, etc. — same path on every Node service
```

All should return `200 {"status":"ok"}` (or similar) once each service's
migrations have run, independent of whether NATS/Redis are up.

## 9. Running tests

Every service follows the same two-tier convention:

```bash
npm run test               # unit — no DB/Redis/NATS required (Node services)
npm run test:integration   # integration — requires that service's own migrations already applied
```

```bash
pytest tests/unit          # forecasting-service / scheduling-service
pytest tests/integration   # requires migrations applied + a running worker (scheduling-service only)
```

The root's `npm run test`/`test:integration` (via `test/jest-unit.json` /
`test/jest-integration.json`) actually runs **every** Node service's own
test suite in one pass from the repo root — useful for a full-platform
check, but if you're iterating on one service, `cd` into it and run its own
`npm run test` for a faster loop.

## Troubleshooting

- **`FATAL: role "agno_app" does not exist`** — step 2 (`scripts/init-roles.sql`)
  wasn't run, or was run against the wrong database.
- **A Node service won't start, complaining about a missing table/column** —
  its own `npm run migration:run` hasn't been applied yet; each service owns
  its own migration history independently of the others.
- **`403`/`401` calling forecasting-service or scheduling-service directly**
  (e.g. via `curl`) — they now require a real `Authorization: Bearer <JWT>`
  minted by the root service, not a raw `X-Tenant-Id` header. Log into
  web-console and copy its access token from browser dev tools, or mint one
  via the root service's `POST /oauth/token`.
- **scheduling-service jobs stay `queued` forever** — the worker process
  (`python -m app.worker`) isn't running; the API process alone never solves
  anything (see step 5).
- **`pip install -e ".[dev]"` fails with `ResolutionImpossible` in
  scheduling-service** — expected, see step 5's install-order workaround.
