import { ExpoPushForwardFailedError } from '../../src/push/errors/expo-push-forward-failed.error';
import { ExpoPushClient } from '../../src/push/expo-push-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ExpoPushClient', () => {
  const pushToken = 'ExponentPushToken[abc123]';
  const message = { title: 'Leave request approved', body: 'Your leave request was approved.' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends to the configured Expo push API URL with the message payload', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { data: [{ status: 'ok' }] }));
    const client = new ExpoPushClient();

    await client.send(pushToken, message);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(JSON.parse(init?.body as string)).toEqual({
      to: pushToken,
      title: message.title,
      body: message.body,
      data: undefined,
    });
  });

  it('returns ok=true on a successful ticket', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { data: [{ status: 'ok' }] }));
    const client = new ExpoPushClient();

    await expect(client.send(pushToken, message)).resolves.toEqual({ ok: true });
  });

  it('returns ok=false with errorType=DeviceNotRegistered on that ticket outcome (HTTP 200, not thrown)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        data: [{ status: 'error', message: 'device not registered', details: { error: 'DeviceNotRegistered' } }],
      }),
    );
    const client = new ExpoPushClient();

    await expect(client.send(pushToken, message)).resolves.toEqual({ ok: false, errorType: 'DeviceNotRegistered' });
  });

  it('returns ok=false with a different errorType for a non-dead-token ticket error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        data: [{ status: 'error', message: 'rate exceeded', details: { error: 'MessageRateExceeded' } }],
      }),
    );
    const client = new ExpoPushClient();

    await expect(client.send(pushToken, message)).resolves.toEqual({ ok: false, errorType: 'MessageRateExceeded' });
  });

  it('throws ExpoPushForwardFailedError on a non-2xx HTTP status from the API itself', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(500, { error: 'internal' }));
    const client = new ExpoPushClient();

    await expect(client.send(pushToken, message)).rejects.toThrow(ExpoPushForwardFailedError);
  });

  it('throws ExpoPushForwardFailedError on an unreadable response body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    const client = new ExpoPushClient();

    await expect(client.send(pushToken, message)).rejects.toThrow(ExpoPushForwardFailedError);
  });

  it('throws ExpoPushForwardFailedError on a network-level failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'));
    const client = new ExpoPushClient();

    await expect(client.send(pushToken, message)).rejects.toThrow(ExpoPushForwardFailedError);
  });
});
