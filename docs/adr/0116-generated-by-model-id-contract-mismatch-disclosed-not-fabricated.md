# ADR-0116: `SubmitExplanationRequest.generatedByModelId` is a uuid Module 10 can never legitimately populate — sent as `null`, disclosed, not faked

## Context
Module 04's `ScheduleExplanation.generated_by_model_id` (and `SubmitExplanationRequest.generatedByModelId`) is typed `uuid.UUID | None` - built in Module 04's own Phase 6, before Module 10 existed to actually call it, on an assumption that generating an explanation means picking a row from some AI-model registry keyed by uuid.

No such registry exists anywhere in this platform. Module 10's own `AIInteraction.model_used` (§2.1's literal column) is a **string** (`"anthropic:claude-...@schedule-explanation-v1"` per ADR-0117/`PROMPT_TEMPLATE_VERSION`) - the natural identifier for "which model produced this," matching how every LLM provider actually names its models. There is nothing in this module, or anywhere else in this repo, that would ever mint a `uuid` for an Anthropic or OpenAI model.

## Decision
`SchedulingWritebackClientService.submitScheduleExplanation` always sends `generatedByModelId: null`. This is not a placeholder to fix later in the same shape - it's a disclosed, permanent mismatch between what Module 04's Phase 6 schema assumed and what actually exists, the same class of gap ADR-0059 already disclosed for the employment-policy JSON contract nobody had pinned down. Fabricating a uuid (e.g. hashing the model string) was considered and rejected: it would create a value that looks like a real foreign-key-shaped identifier while referring to nothing, which is worse than an honest `null`.

## Consequences
- `ScheduleExplanationResponse.generatedByModelId` will always read back `null` for every explanation Module 10 submits, for as long as this mismatch stands.
- If a real cross-module "AI model registry" ever gets built (e.g. as part of a future audit/governance requirement to track exactly which model version produced which output by a stable id, not just a string), that's a schema change on **both** sides (a new uuid-keyed registry table, plus Module 04's column finally getting a real value) - not something to retrofit by inventing a fake key today.
- `AIInteraction.model_used` (the string form) remains the actual source of truth for "which model" within Module 10's own audit trail - this mismatch only affects the one field Module 04's own schema exposes back to its own callers.
