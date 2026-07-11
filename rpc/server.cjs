const http = require('node:http');

const { acquireStateLock } = require('./state-lock.cjs');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8_545;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

const PARSE_ERROR = Object.freeze({
  jsonrpc: '2.0',
  id: null,
  error: Object.freeze({ code: -32_700, message: 'Parse error' }),
});

class RequestError extends Error {
  constructor(statusCode) {
    super(`HTTP request rejected with status ${statusCode}`);
    this.statusCode = statusCode;
  }
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('RPC server options must be an object');
  }
  if (
    options.handlers === null ||
    typeof options.handlers !== 'object' ||
    typeof options.handlers.handle !== 'function' ||
    typeof options.handlers.recoverStartup !== 'function'
  ) {
    throw new Error('RPC server handlers must expose handle and recoverStartup functions');
  }
  if (typeof options.statePath !== 'string' || options.statePath.length === 0 || options.statePath.includes('\0')) {
    throw new Error('RPC server statePath must be a nonempty filesystem path');
  }

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const acquireLock = options.acquireLock ?? acquireStateLock;
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('RPC server host must be a nonempty string');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('RPC server port must be an integer from 0 to 65535');
  }
  if (typeof acquireLock !== 'function') {
    throw new Error('RPC server acquireLock must be a function');
  }

  return Object.freeze({
    acquireLock,
    handlers: options.handlers,
    headersTimeoutMs: validatePositiveInteger(
      options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
      'RPC server headersTimeoutMs',
    ),
    host,
    maxRequestBytes: validatePositiveInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'RPC server maxRequestBytes',
    ),
    port,
    requestTimeoutMs: validatePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'RPC server requestTimeoutMs',
    ),
    shutdownGraceMs: validatePositiveInteger(
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      'RPC server shutdownGraceMs',
    ),
    statePath: options.statePath,
  });
}

function sendEmpty(response, statusCode, headers, callback) {
  if (response.destroyed || response.writableEnded) {
    callback?.();
    return;
  }
  response.writeHead(statusCode, { 'content-length': '0', ...headers });
  response.end(callback);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function isSupportedContentType(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const parts = value.split(';').map(part => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') {
    return false;
  }
  if (parts.length === 0) {
    return true;
  }
  return parts.length === 1 && /^charset\s*=\s*"?utf-8"?$/i.test(parts[0]);
}

function isSupportedContentEncoding(value) {
  return value === undefined || (typeof value === 'string' && value.trim().toLowerCase() === 'identity');
}

function declaredBodySize(request) {
  const value = request.headers['content-length'];
  if (value === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RequestError(400);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new RequestError(413);
  }
  return size;
}

function readBody(request, maxRequestBytes, requestTimeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new RequestError(408)), requestTimeoutMs);

    function cleanup() {
      clearTimeout(timer);
      request.off('aborted', onAborted);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    }

    function finish(error, body) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve(body);
      } else {
        reject(error);
      }
    }

    function onAborted() {
      finish(new RequestError(400));
    }

    function onData(chunk) {
      byteLength += chunk.length;
      if (byteLength > maxRequestBytes) {
        finish(new RequestError(413));
        request.resume();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      finish(undefined, Buffer.concat(chunks, byteLength));
    }

    function onError() {
      finish(new RequestError(400));
    }

    request.on('aborted', onAborted);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function responseId(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const id = payload.id;
  return id === null || typeof id === 'string' || typeof id === 'number' ? id : null;
}

function internalError(payload) {
  return {
    jsonrpc: '2.0',
    id: responseId(payload),
    error: { code: -32_603, message: 'Internal error' },
  };
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)));
  });
}

function createRpcServer(rawOptions) {
  const options = validateOptions(rawOptions);
  const sockets = new Set();
  const inFlight = new Set();
  let address;
  let lock;
  let phase = 'idle';
  let releasePromise;
  let startPromise;
  let stopPromise;

  async function handleHttpRequest(request, response) {
    if (request.url === '/healthz') {
      if (request.method !== 'GET') {
        sendEmpty(response, 405, { allow: 'GET' });
        return;
      }
      const ready = phase === 'ready';
      sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'draining' });
      return;
    }
    if (request.url !== '/') {
      sendEmpty(response, 404);
      return;
    }
    if (request.method !== 'POST') {
      sendEmpty(response, 405, { allow: 'POST' });
      return;
    }
    if (phase !== 'ready') {
      sendEmpty(response, 503);
      return;
    }
    if (!isSupportedContentType(request.headers['content-type'])) {
      sendEmpty(response, 415);
      return;
    }
    if (!isSupportedContentEncoding(request.headers['content-encoding'])) {
      sendEmpty(response, 415);
      return;
    }

    let declaredSize;
    try {
      declaredSize = declaredBodySize(request);
    } catch (error) {
      request.resume();
      sendEmpty(response, error.statusCode ?? 400, { connection: 'close' }, () => request.destroy());
      return;
    }
    if (declaredSize !== undefined && declaredSize > options.maxRequestBytes) {
      request.resume();
      sendEmpty(response, 413, { connection: 'close' }, () => request.destroy());
      return;
    }

    let body;
    try {
      body = await readBody(request, options.maxRequestBytes, options.requestTimeoutMs);
    } catch (error) {
      const statusCode = error instanceof RequestError ? error.statusCode : 400;
      const closeConnection = statusCode === 408 || statusCode === 413;
      sendEmpty(
        response,
        statusCode,
        closeConnection ? { connection: 'close' } : undefined,
        closeConnection ? () => request.destroy() : undefined,
      );
      return;
    }
    if (phase !== 'ready') {
      sendEmpty(response, 503);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(response, 200, PARSE_ERROR);
      return;
    }

    const operation = Promise.resolve().then(() => options.handlers.handle(payload));
    inFlight.add(operation);
    let result;
    try {
      result = await operation;
    } catch {
      sendJson(response, 200, internalError(payload));
      return;
    } finally {
      inFlight.delete(operation);
    }

    if (response.destroyed || response.writableEnded) {
      return;
    }
    if (result === undefined) {
      sendEmpty(response, 204);
      return;
    }
    try {
      sendJson(response, 200, result);
    } catch {
      if (!response.headersSent) {
        sendJson(response, 200, internalError(payload));
      } else {
        response.destroy();
      }
    }
  }

  const server = http.createServer(
    {
      connectionsCheckingInterval: Math.min(options.headersTimeoutMs, options.requestTimeoutMs, 1_000),
      headersTimeout: Math.min(options.headersTimeoutMs, options.requestTimeoutMs),
      requestTimeout: options.requestTimeoutMs,
    },
    (request, response) => {
      void handleHttpRequest(request, response).catch(() => {
        if (!response.headersSent) {
          sendJson(response, 200, internalError(null));
        } else {
          response.destroy();
        }
      });
    },
  );
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function releaseLock() {
    if (lock === undefined) {
      return Promise.resolve();
    }
    if (releasePromise === undefined) {
      releasePromise = Promise.resolve().then(() => lock.release());
    }
    return releasePromise;
  }

  function listen() {
    return new Promise((resolve, reject) => {
      function onError(error) {
        server.off('listening', onListening);
        reject(error);
      }
      function onListening() {
        server.off('error', onError);
        resolve();
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: options.host, port: options.port });
    });
  }

  function start() {
    if (startPromise !== undefined) {
      return startPromise;
    }
    if (phase !== 'idle') {
      return Promise.reject(new Error('RPC server cannot be restarted after shutdown'));
    }
    phase = 'starting';
    startPromise = (async () => {
      try {
        lock = await options.acquireLock(options.statePath);
        await options.handlers.recoverStartup(lock);
        await listen();
        const bound = server.address();
        address = Object.freeze({ host: options.host, port: bound.port });
        phase = 'ready';
        return address;
      } catch (error) {
        phase = 'stopped';
        address = undefined;
        if (lock === undefined) {
          throw error;
        }
        try {
          await releaseLock();
        } catch (releaseError) {
          throw new AggregateError([error, releaseError], 'RPC server startup and state lock release both failed');
        }
        throw error;
      }
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    stopPromise = (async () => {
      if (phase === 'idle') {
        phase = 'stopped';
        return;
      }
      if (phase === 'starting') {
        try {
          await startPromise;
        } catch {
          if (releasePromise !== undefined) {
            await releasePromise;
          }
          return;
        }
      }
      if (phase === 'stopped') {
        if (releasePromise !== undefined) {
          await releasePromise;
        }
        return;
      }

      phase = 'draining';
      const listenerClose = closeServer(server);
      const forceClose = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, options.shutdownGraceMs);
      forceClose.unref();

      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      let closeError;
      try {
        await listenerClose;
      } catch (error) {
        closeError = error;
      } finally {
        clearTimeout(forceClose);
      }
      address = undefined;
      phase = 'stopped';
      try {
        await releaseLock();
      } catch (releaseError) {
        if (closeError !== undefined) {
          throw new AggregateError([closeError, releaseError], 'RPC listener and state lock release both failed');
        }
        throw releaseError;
      }
      if (closeError !== undefined) {
        throw closeError;
      }
    })();
    return stopPromise;
  }

  return Object.freeze({
    address: () => address,
    start,
    stop,
  });
}

module.exports = {
  createRpcServer,
};
