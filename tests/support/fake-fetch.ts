/**
 * A recording stand-in for global `fetch`. Every request is captured with its
 * URL, method, normalized (lower-case) headers and parsed JSON body, and each
 * call is answered from a queue of canned responses, in order.
 *
 * It sits BELOW whatever HTTP client the provider uses, so the assertions made
 * against it describe what goes over the wire, not how the client is built.
 */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CannedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: RecordedRequest[];
  /** Queue one more response. */
  respond(response: CannedResponse): FakeFetch;
}

export function fakeFetch(...responses: CannedResponse[]): FakeFetch {
  const queue = [...responses];
  const calls: RecordedRequest[] = [];

  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const raw = init.body;
    const body = typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : undefined;
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), headers, body });

    const next = queue.shift();
    if (!next) {
      throw new Error(`fakeFetch: no response queued for ${init.method ?? "GET"} ${url}`);
    }
    const status = next.status ?? 200;
    const payload = status === 204 || next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...next.headers },
    });
  }) as FakeFetch;

  fn.calls = calls;
  fn.respond = (response) => {
    queue.push(response);
    return fn;
  };
  return fn;
}
