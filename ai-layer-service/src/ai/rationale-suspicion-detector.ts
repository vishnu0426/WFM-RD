/**
 * ADR-0131's own disclosed finding, addressed for real in Phase 9
 * (docs/adr/0133): `AiRecommendation.rationaleText` is stored verbatim from
 * the generating `AiInteraction.outputText` (§4/non-negotiable #2 - the
 * model's own words, never sanitized), and is the primary thing a human
 * reviewer reads before approving or rejecting. Human-in-the-loop is a
 * defense against the human's own judgment being deceived by that prose,
 * not a code-level control - this detector doesn't change that, but it
 * gives the human a concrete, visible warning instead of nothing at all.
 *
 * Deliberately a narrow, disclosed **heuristic**, not a claim of complete
 * coverage: a fixed phrase list can be evaded by rephrasing, and this
 * module has no live LLM call available anywhere in its own build to run a
 * second, smarter classification pass over the text. Flagging a false
 * positive costs a reviewer a moment's extra attention; missing a real one
 * costs nothing this detector didn't already fail to provide before it
 * existed - the asymmetry favors flagging liberally.
 */
const SUSPICIOUS_PHRASE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'claims_prior_approval',
    pattern:
      /\b(pre-?approved|already approved|previously approved|approved by (the )?(admin|administrator|platform))\b/i,
  },
  {
    label: 'discourages_review',
    pattern:
      /\b(no (further |additional )?review (is )?(needed|required|necessary)|skip (the )?review|no need to (check|verify|confirm))\b/i,
  },
  {
    label: 'claims_already_executed',
    pattern:
      /\b(already (executed|completed|finalized|done)|(has|have) (already )?been (executed|completed|finalized))\b/i,
  },
  {
    label: 'urgency_pressure',
    pattern: /\b(urgent(ly)?[,.]? (approve|confirm|act) (now|immediately)|act now|immediate action required)\b/i,
  },
  {
    label: 'instruction_to_system',
    pattern: /\b(set (autonomy|confidence)|auto[_-]?execute|ignore (previous|prior) instructions)\b/i,
  },
];

/** Returns the label of every suspicious phrase pattern found in `text` - empty if none. Order matches `SUSPICIOUS_PHRASE_PATTERNS`, not appearance order in the text. */
export function detectSuspiciousRationalePhrases(text: string): string[] {
  return SUSPICIOUS_PHRASE_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}
