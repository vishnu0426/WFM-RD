import { OllamaReachabilityChecker } from '../../../src/ai/ollama-reachability-checker';

describe('OllamaReachabilityChecker', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports reachable on a 2xx response from GET {baseUrl}/api/tags', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const checker = new OllamaReachabilityChecker();

    const result = await checker.check('http://tenant-ollama.internal:11434');

    expect(result).toEqual({ reachable: true });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://tenant-ollama.internal:11434/api/tags',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('strips a trailing slash from baseUrl before appending the probe path', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const checker = new OllamaReachabilityChecker();

    await checker.check('http://tenant-ollama.internal:11434/');

    expect(global.fetch).toHaveBeenCalledWith('http://tenant-ollama.internal:11434/api/tags', expect.anything());
  });

  it('reports unreachable with the HTTP status on a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const checker = new OllamaReachabilityChecker();

    const result = await checker.check('http://tenant-ollama.internal:11434');

    expect(result).toEqual({ reachable: false, error: 'HTTP 503' });
  });

  it('reports unreachable with the underlying error message on a network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:11434'));
    const checker = new OllamaReachabilityChecker();

    const result = await checker.check('http://tenant-ollama.internal:11434');

    expect(result).toEqual({ reachable: false, error: 'connect ECONNREFUSED 10.0.0.5:11434' });
  });

  it('reports unreachable on a timeout (AbortSignal.timeout firing)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError'));
    const checker = new OllamaReachabilityChecker();

    const result = await checker.check('http://tenant-ollama.internal:11434');

    expect(result.reachable).toBe(false);
  });
});
