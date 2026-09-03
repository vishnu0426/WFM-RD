import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

/**
 * Own copy of adherence-compliance-service's/shift-marketplace-service's/
 * intraday-service's `json.scalar.ts` (ADR-0039 precedent), for
 * `SavedReport.config`/`DashboardWidget.position` (§2.1) - both are
 * free-form jsonb whose shape varies by `reportType`/`widgetType`, so a
 * typed GraphQL object isn't a fit. Hand-rolled rather than
 * `graphql-type-json`: the full behavior needed is "pass an arbitrary
 * JSON value through unchanged," a handful of lines, not a dependency.
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
