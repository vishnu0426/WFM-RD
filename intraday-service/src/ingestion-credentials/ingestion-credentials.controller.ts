import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { CreateIngestionCredentialDto } from './dto/create-ingestion-credential.dto';
import { IngestionCredential } from './entities/ingestion-credential.entity';
import { CreateIngestionCredentialResult, IngestionCredentialsService } from './ingestion-credentials.service';

/**
 * Self-service issuance/revocation for the HMAC secret an on-prem
 * collector (or any other ACD/CCaaS webhook source) signs its inbound
 * `POST /v1/intraday/tenants/:tenantId/activity-events` requests with -
 * the admin-facing counterpart to `HmacSignatureGuard`'s own read path.
 * Same "tenant admin self-issues, no platform bootstrap secret needed"
 * posture `src/modules/scim/rest/scim-credentials.controller.ts` already
 * established for the analogous SCIM inbound-push credential.
 */
@Controller('v1/intraday/ingestion-credentials')
export class IngestionCredentialsController {
  constructor(
    private readonly credentials: IngestionCredentialsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post()
  async create(@Body() body: CreateIngestionCredentialDto): Promise<CreateIngestionCredentialResult> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.credentials.create(tenantId, body.label);
  }

  @Get()
  async list(): Promise<IngestionCredential[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.credentials.listAllForTenant(tenantId);
  }

  @Post(':id/revoke')
  async revoke(@Param('id', new ParseUUIDPipe()) id: string): Promise<IngestionCredential> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.credentials.revoke(tenantId, id);
  }
}
