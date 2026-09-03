import { Controller, Get } from '@nestjs/common';

/**
 * RFC 7644 §4's discovery endpoints. Mainstream SCIM connector setup flows
 * (Okta, Entra ID) probe `ServiceProviderConfig`/`ResourceTypes` before
 * allowing an admin to save the connector config at all, so these exist even
 * though `/scim/v2/Schemas` (also §4, less commonly hard-required) doesn't -
 * flagged as a gap in the production readiness checklist, not silently
 * omitted. Unauthenticated by design (RFC 7644 doesn't require auth for
 * discovery, and these responses carry no tenant data).
 */
@Controller('scim/v2')
export class ScimDiscoveryController {
  @Get('ServiceProviderConfig')
  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authenticate with an access token issued via the client_credentials grant.',
          specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
        },
      ],
    };
  }

  @Get('ResourceTypes')
  resourceTypes() {
    return [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/scim/v2/Users',
        schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/scim/v2/Groups',
        schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
      },
    ];
  }
}
