# ADR-0001: TypeORM for persistence + hand-written SQL migrations

## Context
Module 01 needs: (a) tight NestJS integration, (b) a subclassable repository so a
tenant-isolation guard can wrap every query (ADR-0002), and (c) migrations that can
express Postgres features no ORM schema DSL covers natively — `CREATE POLICY`,
`GRANT`/`REVOKE`, triggers, and `PARTITION BY RANGE`.

## Decision
Use `@nestjs/typeorm` + `typeorm` for entities and the repository layer. Migrations
are TypeORM migration classes whose `up`/`down` bodies are raw SQL via
`queryRunner.query(...)` — not `synchronize: true`, and not TypeORM's decorator-driven
schema generation, since neither can express RLS/grants/partitioning.

## Consequences
- Entities (`src/modules/**/entities/*.entity.ts`) are the TypeScript source of truth
  for column names/types; migrations (`src/database/migrations/*.ts`) are the
  authoritative DDL. A CI check (`npm run migration:lint`) diffs the two so they
  cannot silently drift — see `src/database/migration-lint.ts`.
- `synchronize` is hard-coded `false` in `src/database/data-source.ts` (not just
  defaulted) so a misconfigured `NODE_ENV` can never trigger destructive
  auto-migration against a real database.
- Downside: writing DDL by hand is slower than Prisma's diff-based migration
  generation. Accepted — see the Phase 1 design doc for why Prisma didn't remove
  this cost anyway (RLS/grants/partitioning still need raw SQL under either ORM).
