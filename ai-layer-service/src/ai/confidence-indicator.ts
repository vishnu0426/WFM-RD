/**
 * §0.5's "explainability of the explainability layer": `confidence_indicator`
 * must be "a defensible signal ..., not a cosmetic field - document exactly
 * how it's computed." This is that documentation, made executable.
 *
 * `confidence_indicator = 0.5 * selfReportedConfidence + 0.5 * groundedness`,
 * rounded to 2 decimal places (matching the `numeric(3,2)` column):
 *
 * - `selfReportedConfidence` - the LLM's own stated confidence (0-1),
 *   requested explicitly in the system prompt's response-shape
 *   instructions. Cheap to fabricate on the model's part, which is exactly
 *   why it's only half the signal.
 * - `groundedness` - the fraction of numeric tokens appearing in
 *   `outputText` that also appear verbatim in the serialized
 *   `inputContext` - a mechanical check on "how much of the response is
 *   directly traceable to input_context vs. general phrasing" (§0.5's own
 *   framing). A response citing figures nowhere in the source data scores
 *   low here regardless of how confident the model claims to be.
 *
 * If `outputText` contains no numeric tokens at all, groundedness is a
 * neutral 0.5 - deliberately not 1.0 (there is nothing to verify, so full
 * credit would be unearned) and not 0.0 (a short, accurate, non-numeric
 * summary shouldn't be penalized as if it were fabricated).
 *
 * Phase 9 (docs/adr/0133, prompt-injection ADR-0131's own disclosed
 * finding): before serializing `inputContext` for the groundedness
 * comparison, `reason`/`question` - the tenant-user-authored free-text
 * fields §5.2 already treats as untrusted content - are redacted
 * (`stripUntrustedFreeText`, recursive, any depth). Without this, a `reason`
 * field crafted to echo real structured data already present elsewhere in
 * `inputContext` (queue/employee ids a supervisor plausibly already knows)
 * could earn full credit for numbers the model never had to find - it was
 * simply told them, by the same field it isn't supposed to take
 * instructions from. Numbers appearing anywhere else in `inputContext`
 * (objective scores, queue ids, timestamps - all sourced from validated
 * gRPC responses, never tenant-authored prose) still count normally.
 */
const NUMERIC_TOKEN_PATTERN = /-?\d+(\.\d+)?/g;

/** Untrusted free-text field names redacted before the groundedness comparison - see this file's own doc comment. Matched by key name at any depth, not by interaction type, so a future interaction type reusing either name is covered automatically. */
const UNTRUSTED_FREE_TEXT_KEYS = new Set(['reason', 'question']);

function stripUntrustedFreeText(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUntrustedFreeText);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = UNTRUSTED_FREE_TEXT_KEYS.has(key) ? null : stripUntrustedFreeText(entry);
    }
    return result;
  }
  return value;
}

export function computeGroundedness(outputText: string, inputContextJson: string): number {
  const tokens = outputText.match(NUMERIC_TOKEN_PATTERN);
  if (!tokens || tokens.length === 0) {
    return 0.5;
  }
  const matched = tokens.filter((token) => inputContextJson.includes(token)).length;
  return matched / tokens.length;
}

export function computeConfidenceIndicator(
  selfReportedConfidence: number,
  outputText: string,
  inputContext: unknown,
): number {
  const clampedSelfReported = Math.max(0, Math.min(1, selfReportedConfidence));
  const groundedness = computeGroundedness(outputText, JSON.stringify(stripUntrustedFreeText(inputContext)));
  const combined = 0.5 * clampedSelfReported + 0.5 * groundedness;
  return Math.round(combined * 100) / 100;
}
