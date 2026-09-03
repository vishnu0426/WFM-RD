import { Injectable } from '@nestjs/common';
import { BulkImportClientUnavailableError, BulkImportJobTimeoutError } from './bulk-import-client.errors';

export interface BulkImportRecord {
  employeeNumber: string;
  orgUnitId: string;
  employmentType: string;
  contractHoursPerWeek: number;
  hireDate: string;
  costCenter?: string;
  managerEmployeeId?: string;
}

export interface BulkImportJobResult {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  dryRun: boolean;
  totalRecords: number;
  result: {
    creates: { employeeNumber: string }[];
    updates: { employeeNumber: string; changes?: unknown }[];
    conflicts: { employeeNumber: string; reason: string }[];
    committed?: { created: number; updated: number };
  } | null;
  error: string | null;
}

/**
 * §0/§2.2 rule 3a: the real, sanctioned write path for batch (hris|payroll|crm)
 * connectors - Module 02's own `POST /v1/employees/bulk-import` (real, live,
 * already built - `docs/module-02-runbook.md` §3), never a direct write to
 * `org.employees`. Module 02's own docs disclose this endpoint has no
 * durable job queue (fire-and-forget in-process async,
 * `docs/module-02-phase-6-production-readiness-checklist.md`), which is why
 * this client polls `GET /v1/jobs/:id` with a bounded budget rather than
 * assuming a webhook/callback completion signal exists.
 *
 * Auth: `X-Tenant-Id` header only, no bearer token - `BulkImportController`
 * has no `@UseGuards(...)`, and `TenantContextMiddleware`'s own doc comment
 * names bulk-import as one of Module 02's pre-RBAC endpoints where this is
 * the real, current trust model (verified live against the actual running
 * service, not assumed from reading the code).
 */
@Injectable()
export class BulkImportClientService {
  private readonly baseUrl = process.env.CORE_SERVICE_URL ?? 'http://localhost:3000';
  private readonly pollIntervalMs = Number(process.env.BULK_IMPORT_POLL_INTERVAL_MS ?? 250);
  private readonly maxPollAttempts = Number(process.env.BULK_IMPORT_MAX_POLL_ATTEMPTS ?? 40);

  async submitAndAwait(tenantId: string, dryRun: boolean, records: BulkImportRecord[]): Promise<BulkImportJobResult> {
    const submitted = await this.submit(tenantId, dryRun, records);
    return this.awaitCompletion(tenantId, submitted.id);
  }

  private async submit(tenantId: string, dryRun: boolean, records: BulkImportRecord[]): Promise<BulkImportJobResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/employees/bulk-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
        body: JSON.stringify({ dryRun, records }),
      });
    } catch (err) {
      throw new BulkImportClientUnavailableError('submit', (err as Error).message);
    }
    if (!response.ok) {
      throw new BulkImportClientUnavailableError('submit', `HTTP ${response.status}: ${await this.safeBody(response)}`);
    }
    return (await response.json()) as BulkImportJobResult;
  }

  private async awaitCompletion(tenantId: string, jobId: string): Promise<BulkImportJobResult> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      const job = await this.getJob(tenantId, jobId);
      if (job.status === 'completed' || job.status === 'failed') {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new BulkImportJobTimeoutError(jobId);
  }

  private async getJob(tenantId: string, jobId: string): Promise<BulkImportJobResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/jobs/${jobId}`, {
        method: 'GET',
        headers: { 'X-Tenant-Id': tenantId },
      });
    } catch (err) {
      throw new BulkImportClientUnavailableError('poll', (err as Error).message);
    }
    if (!response.ok) {
      throw new BulkImportClientUnavailableError('poll', `HTTP ${response.status}: ${await this.safeBody(response)}`);
    }
    return (await response.json()) as BulkImportJobResult;
  }

  private async safeBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<unreadable body>';
    }
  }
}
