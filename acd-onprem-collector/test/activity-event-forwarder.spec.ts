import { createHmac } from "node:crypto";
import {
  ActivityEvent,
  ActivityEventForwardError,
  ActivityEventForwarder,
} from "../src/activity-event-forwarder";

const EVENT: ActivityEvent = {
  sourceEventId: "src-1",
  employeeId: "emp-1",
  currentActivity: "ready",
  activityStartedAt: "2026-08-26T10:00:00.000Z",
};

function makeFetch(
  responseFactory: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    responseFactory(input, init),
  );
}

describe("ActivityEventForwarder.forward", () => {
  it("POSTs to the correct tenant-scoped ingestion URL with a JSON body", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 202 }));
    const forwarder = new ActivityEventForwarder(
      "https://intraday.example.com",
      "t1",
      "secret",
      fetchImpl as never,
    );

    await forwarder.forward(EVENT);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://intraday.example.com/v1/intraday/tenants/t1/activity-events",
      expect.objectContaining({ method: "POST", body: JSON.stringify(EVENT) }),
    );
  });

  it("signs the request with the exact t=<ms>,v1=<hmac> scheme HmacSignatureGuard verifies", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = makeFetch((_url, init) => {
      capturedInit = init;
      return new Response(null, { status: 202 });
    });
    const forwarder = new ActivityEventForwarder(
      "https://intraday.example.com",
      "t1",
      "my-secret",
      fetchImpl as never,
    );

    await forwarder.forward(EVENT);

    const header = (capturedInit?.headers as Record<string, string>)[
      "x-agno-webhook-signature"
    ];
    const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, timestamp, signature] = match!;

    // Independent recomputation - mirrors exactly what
    // `intraday-service/src/ingestion/hmac-signature.guard.ts` computes on
    // the receiving end: HMAC-SHA256(secret, "${timestamp}.${rawBody}").
    const expected = createHmac("sha256", "my-secret")
      .update(`${timestamp}.${JSON.stringify(EVENT)}`)
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it('returns "accepted" for a 202 and "duplicate" for a 200', async () => {
    const accepted = new ActivityEventForwarder(
      "https://intraday.example.com",
      "t1",
      "s",
      makeFetch(() => new Response(null, { status: 202 })) as never,
    );
    await expect(accepted.forward(EVENT)).resolves.toBe("accepted");

    const duplicate = new ActivityEventForwarder(
      "https://intraday.example.com",
      "t1",
      "s",
      makeFetch(() => new Response(null, { status: 200 })) as never,
    );
    await expect(duplicate.forward(EVENT)).resolves.toBe("duplicate");
  });

  it("throws ActivityEventForwardError with the status for a non-2xx response", async () => {
    const forwarder = new ActivityEventForwarder(
      "https://intraday.example.com",
      "t1",
      "s",
      makeFetch(() => new Response(null, { status: 401 })) as never,
    );

    await expect(forwarder.forward(EVENT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("throws ActivityEventForwardError with no status on a network failure", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const forwarder = new ActivityEventForwarder(
      "https://intraday.example.com",
      "t1",
      "s",
      fetchImpl as never,
    );

    await expect(forwarder.forward(EVENT)).rejects.toBeInstanceOf(
      ActivityEventForwardError,
    );
    await expect(forwarder.forward(EVENT)).rejects.toMatchObject({
      status: undefined,
    });
  });
});
