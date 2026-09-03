import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

/**
 * Own copy of the platform's `json.scalar.ts` (ADR-0039 precedent), for
 * `IntegrationConnector.config`/`FieldMapping.transformationRule`/
 * `SyncJob.errorDetails`/`ProviderRateLimitConfig.backoffStrategy`/
 * `WebhookDelivery.payload` - all genuinely variable-shape JSON, not a fit
 * for a typed GraphQL object.
 */
@Scalar('JSON', () => Object)
export class JsonScalar implements CustomScalar<unknown, unknown> {
  description = 'Arbitrary JSON value (object, array, string, number, boolean, or null).';

  parseValue(value: unknown): unknown {
    return value;
  }

  serialize(value: unknown): unknown {
    return value;
  }

  parseLiteral(ast: ValueNode): unknown {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT:
        return Object.fromEntries(ast.fields.map((field) => [field.name.value, this.parseLiteral(field.value)]));
      case Kind.LIST:
        return ast.values.map((value) => this.parseLiteral(value));
      case Kind.NULL:
        return null;
      default:
        return undefined;
    }
  }
}
