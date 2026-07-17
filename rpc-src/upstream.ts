/** Options accepted by {@link createUpstreamClient}. */
export interface CreateUpstreamClientOptions {
  fetch?: typeof fetch;
}

/** The JSON-RPC client returned by {@link createUpstreamClient}. */
export interface UpstreamClient {
  request(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

class UpstreamRpcError extends Error {
  declare code: number;
  declare data?: unknown;

  constructor(code: number, message: string, data?: unknown, hasData = false) {
    super(message);
    this.name = 'UpstreamRpcError';
    this.code = code;
    if (hasData) this.data = data;
  }
}

function validateEndpoint(value: string): string {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Invalid upstream JSON-RPC endpoint');
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error('Invalid upstream JSON-RPC endpoint');
  }
  return endpoint.href;
}

function validateResponse(payload: unknown, id: number): unknown {
  if (!isObject(payload) || payload.jsonrpc !== '2.0' || payload.id !== id) {
    throw new Error('Invalid upstream JSON-RPC response');
  }
  const hasResult = own(payload, 'result');
  const hasError = own(payload, 'error');
  if (hasResult === hasError) throw new Error('Invalid upstream JSON-RPC response');
  if (hasResult) return payload.result;
  if (
    !isObject(payload.error) ||
    !Number.isInteger(payload.error.code) ||
    typeof payload.error.message !== 'string' ||
    payload.error.message.length === 0
  ) {
    throw new Error('Invalid upstream JSON-RPC response');
  }
  throw new UpstreamRpcError(
    payload.error.code as number,
    payload.error.message as string,
    payload.error.data,
    own(payload.error, 'data'),
  );
}

function createUpstreamClient(rawEndpoint: string, options: CreateUpstreamClientOptions = {}): UpstreamClient {
  if (!isObject(options)) throw new Error('Invalid upstream JSON-RPC options');
  const endpoint = validateEndpoint(rawEndpoint);
  // `isObject` narrows `options` to `Record<string, unknown>`, which would otherwise
  // discard the specific `fetch` field type; re-assert the declared option shape here.
  const maybeFetch = own(options, 'fetch') ? (options as CreateUpstreamClientOptions).fetch : globalThis.fetch;
  if (typeof maybeFetch !== 'function') throw new Error('A fetch implementation is required');
  const fetchImplementation: typeof fetch = maybeFetch;
  let nextId = 1;

  async function request(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    if (typeof method !== 'string' || method.length === 0) throw new Error('Invalid upstream JSON-RPC method');
    if (!Array.isArray(params) && !isObject(params)) throw new Error('Invalid upstream JSON-RPC params');
    const id = nextId;
    nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    let response;
    try {
      response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
      });
    } catch (error) {
      throw new Error('Upstream JSON-RPC transport failed', { cause: error });
    }
    if (!isObject(response) || typeof response.text !== 'function' || response.ok !== true) {
      throw new Error('Upstream JSON-RPC transport returned an unsuccessful response');
    }
    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch (error) {
      throw new Error('Invalid upstream JSON-RPC response', { cause: error });
    }
    return validateResponse(payload, id);
  }

  return Object.freeze({ request });
}

export { UpstreamRpcError, createUpstreamClient };
