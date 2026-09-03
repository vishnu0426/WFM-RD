import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §5a/ADR-0136: `provider_rate_limit_config` is `agno_migrator`-seeded
 * reference data, never written by the running application. Every row
 * here is sourced from real research against each vendor's own published
 * (or explicitly-confirmed-unpublished) documentation -
 * `docs/module-12-provider-research.md` is the source of truth these
 * values are transcribed from; re-verify there before trusting a number in
 * production, not from this migration's own comments.
 *
 * All 10 providers named across §1/§5a/§5c are seeded now, even though
 * Phase 5's own enforcement logic (`RateLimiterService`,
 * `BatchSyncRunnerService`) only consumes the four batch providers
 * (Workday/SAP SuccessFactors/ADP/Salesforce) - the streaming providers'
 * rows are real, sourced data with nothing wrong with seeding them now,
 * consistent with this platform's "real but not yet consumed" scaffolding
 * posture; Phase 6 is what actually reads them.
 *
 * `null` `requests_per_window`/`window_seconds`/`concurrent_request_limit`
 * are not missing data - they are the accurate transcription of "not
 * publicly documented by this vendor," confirmed in the research doc, not
 * a placeholder to fill in later. `is_published: false` inside
 * `backoff_strategy` marks exactly this case explicitly, for any code path
 * that reads this jsonb column later.
 */
export class SeedProviderRateLimitConfig1700010100000 implements MigrationInterface {
  name = 'SeedProviderRateLimitConfig1700010100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{
      provider: string;
      requestsPerWindow: number | null;
      windowSeconds: number | null;
      concurrentRequestLimit: number | null;
      backoffStrategy: Record<string, unknown>;
    }> = [
      {
        provider: 'Workday',
        requestsPerWindow: 10,
        windowSeconds: 1,
        concurrentRequestLimit: null,
        backoffStrategy: {
          type: 'exponential',
          base_ms: 1000,
          max_retries: 5,
          respect_retry_after: true,
          confidence: 'unconfirmed',
        },
      },
      {
        provider: 'SAP SuccessFactors',
        requestsPerWindow: 30,
        windowSeconds: 1,
        concurrentRequestLimit: 10,
        backoffStrategy: {
          type: 'exponential',
          respect_retry_after: true,
          observed_retry_after_default_s: 300,
          confidence: 'unconfirmed',
        },
      },
      {
        provider: 'ADP',
        requestsPerWindow: 300,
        windowSeconds: 60,
        concurrentRequestLimit: 50,
        backoffStrategy: {
          type: 'exponential',
          note: 'distribute across nodes; single-node concurrency (~12-13) is the more common real trip point than the aggregate cap',
          confidence: 'unconfirmed',
        },
      },
      {
        provider: 'Salesforce',
        requestsPerWindow: 100000,
        windowSeconds: 86400,
        concurrentRequestLimit: 25,
        backoffStrategy: {
          type: 'header_driven',
          header: 'Sforce-Limit-Info',
          on_breach_status: 403,
          on_breach_code: 'REQUEST_LIMIT_EXCEEDED',
          confidence: 'vendor_published',
        },
      },
      {
        provider: 'Genesys Cloud',
        requestsPerWindow: null,
        windowSeconds: null,
        concurrentRequestLimit: 20,
        backoffStrategy: {
          type: 'respect_retry_after',
          channel_topic_cap: 1000,
          note: 'concurrent_request_limit repurposed per ADR-0135 as max WebSocket channels, not REST calls',
          confidence: 'vendor_published',
        },
      },
      {
        provider: 'NICE CXone',
        requestsPerWindow: null,
        windowSeconds: null,
        concurrentRequestLimit: 100,
        backoffStrategy: {
          type: 'exponential',
          note: "no vendor-documented Retry-After; CXone's own docs state limits are 'not standardized' across APIs",
          confidence: 'vendor_published',
        },
      },
      {
        provider: 'Five9',
        requestsPerWindow: null,
        windowSeconds: null,
        concurrentRequestLimit: null,
        backoffStrategy: {
          type: 'exponential',
          is_published: false,
          note: 'fully undocumented by vendor; constrained in practice by licensed WebSocket seat count, not a published rate',
        },
      },
      {
        provider: 'Talkdesk',
        requestsPerWindow: 4,
        windowSeconds: 1,
        concurrentRequestLimit: 15,
        backoffStrategy: {
          type: 'exponential',
          scope_note:
            'the 4 req/s figure is SCIM-specific; the Live API SSE surface has no published rate ceiling - backpressure there is self-imposed per ADR-0135',
          confidence: 'vendor_published',
        },
      },
      {
        provider: 'Avaya Experience Platform',
        requestsPerWindow: null,
        windowSeconds: null,
        concurrentRequestLimit: null,
        backoffStrategy: {
          type: 'exponential',
          is_published: false,
          note: 'self-imposed conservative default only; no vendor number exists to seed against',
        },
      },
      {
        provider: 'Avaya Aura Contact Center / CMS',
        requestsPerWindow: null,
        windowSeconds: null,
        concurrentRequestLimit: null,
        backoffStrategy: {
          type: 'n/a',
          note: 'concurrent_request_limit repurposed per ADR-0135 as max TSAPI sessions or max ODBC connections depending on which §5c mechanism is selected; both are licensing-tier constants configured per tenant deployment, not a vendor-published platform number',
        },
      },
    ];

    for (const row of rows) {
      await queryRunner.query(
        `INSERT INTO integration_hub.provider_rate_limit_config
           (id, provider, requests_per_window, window_seconds, concurrent_request_limit, backoff_strategy)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb)`,
        [
          row.provider,
          row.requestsPerWindow,
          row.windowSeconds,
          row.concurrentRequestLimit,
          JSON.stringify(row.backoffStrategy),
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM integration_hub.provider_rate_limit_config;`);
  }
}
