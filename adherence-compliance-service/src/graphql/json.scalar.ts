import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

/**
 * Own copy of shift-marketplace-service's/intraday-service's `json.scalar.ts`
 * (ADR-0039 precedent), for `ComplianceRule.definition` (§2.1) - its shape
 * varies by `ruleType` (an `overtime_threshold` definition looks nothing
 * like a `rest_period_minimum` one), so a typed GraphQL object isn't a fit.
 * Hand-rolled rather than `graphql-type-json`: the full behavior needed is
 * "pass an arbitrary JSON value through unchanged," a handful of lines, not
 * a dependency.
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
