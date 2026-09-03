import { LlmCallFailedError } from './llm/llm-call-failed.error';

export interface ParsedLlmExplanation {
  summaryText: string;
  topConstraints: Record<string, unknown>;
  tradeOffs: Record<string, unknown>;
  selfReportedConfidence: number;
}

/**
 * Shared by every interaction type that uses the `{summaryText,
 * topConstraints, tradeOffs, selfReportedConfidence}` response shape
 * (`schedule-explanation-prompt.ts`, `forecast-explanation-prompt.ts`,
 * `reallocation-rationale-prompt.ts`, `root-cause-analysis-prompt.ts`) -
 * pulled out once Phase 4 gave this platform a second and third caller of
 * what was, in Phase 2, a schedule-explanation-specific parser (avoiding
 * three near-identical copies).
 *
 * The system prompt always instructs the model to respond with raw JSON
 * only, but real models occasionally wrap it in a markdown code fence
 * regardless of instructions - stripped here rather than treated as a hard
 * failure, same "be lenient about a real model's actual behavior, strict
 * about the data contract" posture as every other external-API integration
 * in this platform. A response that still isn't valid JSON, or is missing
 * a required field, IS a hard failure (`LlmCallFailedError`) - this module
 * never fabricates a summary from a response it couldn't actually parse.
 */
export function parseLlmExplanationResponse(rawText: string): ParsedLlmExplanation {
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = fenceMatch ? fenceMatch[1] : rawText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new LlmCallFailedError(new Error(`model response was not valid JSON: ${(err as Error).message}`));
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).summaryText !== 'string'
  ) {
    throw new LlmCallFailedError(new Error('model response was missing required field "summaryText"'));
  }

  const record = parsed as Record<string, unknown>;
  return {
    summaryText: record.summaryText as string,
    topConstraints: (record.topConstraints as Record<string, unknown>) ?? {},
    tradeOffs: (record.tradeOffs as Record<string, unknown>) ?? {},
    selfReportedConfidence:
      typeof record.selfReportedConfidence === 'number' ? (record.selfReportedConfidence as number) : 0.5,
  };
}
