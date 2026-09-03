import { WebhookDeliveryDispatcherService } from '../../src/modules/webhook/services/webhook-delivery-dispatcher.service';
import { WebhookDeliveryStatus } from '../../src/modules/webhook/entities/webhook-delivery-status.enum';

describe('WebhookDeliveryDispatcherService', () => {
  const makeDelivery = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'delivery-1',
    tenantId: 'tenant-1',
    subscriptionId: 'sub-1',
    subject: 'agno.core.audit.created.v1',
    payload: { foo: 'bar' },
    status: WebhookDeliveryStatus.PENDING,
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    deliveredAt: null,
    ...overrides,
  });

  const makeSubscription = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'sub-1',
    tenantId: 'tenant-1',
    url: 'https://example.com/webhook',
    description: null,
    secret: 'test-secret',
    subscribedSubjects: ['agno.core.audit.created.v1'],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const makeDeps = (delivery: ReturnType<typeof makeDelivery>) => {
    const deliveries = {
      findPendingBatch: jest.fn().mockResolvedValue([delivery]),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      markDeadLettered: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const subscriptions = { findOne: jest.fn().mockResolvedValue(makeSubscription()) };
    const tenantContext = { run: jest.fn((_ctx: unknown, fn: () => unknown) => fn()) };
    return { deliveries, subscriptions, tenantContext };
  };

  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('signs the request with an HMAC over `${timestamp}.${body}` and marks delivered on a 2xx response', async () => {
    const delivery = makeDelivery();
    const deps = makeDeps(delivery);
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as never;

    const service = new WebhookDeliveryDispatcherService(
      deps.deliveries as never,
      deps.subscriptions as never,
      deps.tenantContext as never,
    );
    await service.tick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(delivery.payload));
    const signatureHeader = init.headers['x-agno-webhook-signature'] as string;
    expect(signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(deps.deliveries.markDelivered).toHaveBeenCalledWith('delivery-1');
  });

  it('records a failure (without dead-lettering) on a non-2xx response below the retry ceiling', async () => {
    const delivery = makeDelivery({ attempts: 1 });
    const deps = makeDeps(delivery);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;

    const service = new WebhookDeliveryDispatcherService(
      deps.deliveries as never,
      deps.subscriptions as never,
      deps.tenantContext as never,
    );
    await service.tick();

    expect(deps.deliveries.recordFailure).toHaveBeenCalledWith('delivery-1', 'HTTP 500');
    expect(deps.deliveries.markDeadLettered).not.toHaveBeenCalled();
  });

  it('dead-letters after exhausting retries', async () => {
    const delivery = makeDelivery({ attempts: 4 }); // next failure is the 5th attempt
    const deps = makeDeps(delivery);
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as never;

    const service = new WebhookDeliveryDispatcherService(
      deps.deliveries as never,
      deps.subscriptions as never,
      deps.tenantContext as never,
    );
    await service.tick();

    expect(deps.deliveries.markDeadLettered).toHaveBeenCalledWith('delivery-1', 'connect ECONNREFUSED');
    expect(deps.deliveries.recordFailure).not.toHaveBeenCalled();
  });

  it('dead-letters immediately if the subscription was deleted or deactivated since enqueue', async () => {
    const delivery = makeDelivery();
    const deps = makeDeps(delivery);
    deps.subscriptions.findOne.mockResolvedValue(null);
    global.fetch = jest.fn() as never;

    const service = new WebhookDeliveryDispatcherService(
      deps.deliveries as never,
      deps.subscriptions as never,
      deps.tenantContext as never,
    );
    await service.tick();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(deps.deliveries.markDeadLettered).toHaveBeenCalledWith(
      'delivery-1',
      'subscription deleted or deactivated since enqueue',
    );
  });
});
