import { parseLlmExplanationResponse } from '../../../src/ai/parse-llm-explanation-response';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';

describe('parseLlmExplanationResponse', () => {
  it('parses a well-formed raw JSON response', () => {
    const result = parseLlmExplanationResponse(
      JSON.stringify({
        summaryText: 'This schedule relaxed one constraint.',
        topConstraints: { minRest: '8h' },
        tradeOffs: { relaxed: 1 },
        selfReportedConfidence: 0.8,
      }),
    );
    expect(result.summaryText).toBe('This schedule relaxed one constraint.');
    expect(result.topConstraints).toEqual({ minRest: '8h' });
    expect(result.tradeOffs).toEqual({ relaxed: 1 });
    expect(result.selfReportedConfidence).toBe(0.8);
  });

  it('strips a markdown code fence a real model sometimes adds despite instructions', () => {
    const result = parseLlmExplanationResponse('```json\n{"summaryText": "fenced response"}\n```');
    expect(result.summaryText).toBe('fenced response');
  });

  it('defaults topConstraints/tradeOffs/selfReportedConfidence when omitted', () => {
    const result = parseLlmExplanationResponse(JSON.stringify({ summaryText: 'minimal response' }));
    expect(result.topConstraints).toEqual({});
    expect(result.tradeOffs).toEqual({});
    expect(result.selfReportedConfidence).toBe(0.5);
  });

  it('throws LlmCallFailedError for text that is not valid JSON at all', () => {
    expect(() => parseLlmExplanationResponse('this is not JSON')).toThrow(LlmCallFailedError);
  });

  it('throws LlmCallFailedError when summaryText is missing - never fabricates a summary from an unparseable response', () => {
    expect(() => parseLlmExplanationResponse(JSON.stringify({ topConstraints: {} }))).toThrow(LlmCallFailedError);
  });
});
