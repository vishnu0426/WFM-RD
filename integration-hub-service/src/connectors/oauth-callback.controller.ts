import { Body, Controller, Post } from '@nestjs/common';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { IntegrationConnectorsService } from './integration-connectors.service';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';

/** §3.2. See `IntegrationConnectorsService.completeOAuthCallback`'s own doc comment for why `connectorId` isn't a body field here. */
@Controller('v1/integrations/oauth')
export class OAuthCallbackController {
  constructor(
    private readonly connectors: IntegrationConnectorsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('callback')
  async callback(@Body() dto: OAuthCallbackDto): Promise<{ id: string; status: string }> {
    const tenantId = this.tenantContext.requireTenantId();
    const connector = await this.connectors.completeOAuthCallback(tenantId, dto.code, dto.state);
    return { id: connector.id, status: connector.status };
  }
}
