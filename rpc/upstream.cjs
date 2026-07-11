'use strict';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateEndpoint(value) {
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

function validateResponse(payload, id) {
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
  const error = new Error(payload.error.message);
  error.code = payload.error.code;
  if (own(payload.error, 'data')) error.data = payload.error.data;
  throw error;
}

function createUpstreamClient(rawEndpoint, options = {}) {
  if (!isObject(options)) throw new Error('Invalid upstream JSON-RPC options');
  const endpoint = validateEndpoint(rawEndpoint);
  const fetchImplementation = own(options, 'fetch') ? options.fetch : globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new Error('A fetch implementation is required');
  let nextId = 1;

  async function request(method, params) {
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

module.exports = { createUpstreamClient };
