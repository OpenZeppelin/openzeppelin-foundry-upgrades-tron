import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { TextDecoder } from 'node:util';

import { acquireStateLock } from './state-lock.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8_545;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const PARSE_ERROR = Object.freeze({
  jsonrpc: '2.0',
  id: null,
  error: Object.freeze({ code: -32_700, message: 'Parse error' }),
});

/** The minimal state-lock capability the server acquires, holds, and releases. */
export interface RpcServerLock {
  release(): Promise<void>;
}

/** The RPC handler surface a gateway server dispatches requests to. */
export interface RpcServerHandlers {
  handle(payload: unknown): unknown;
  recoverStartup(lock: RpcServerLock): unknown;
}

/** Options accepted by {@link createRpcServer}. */
export interface CreateRpcServerOptions {
  handlers: RpcServerHandlers;
  statePath: string;
  host?: string;
  port?: number;
  acquireLock?: (statePath: string) => Promise<RpcServerLock>;
  headersTimeoutMs?: number;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}

/** A bound host/port pair, as returned by {@link RpcServer.start} and {@link RpcServer.address}. */
export interface RpcServerAddress {
  host: string;
  port: number;
}

/** The server handle returned by {@link createRpcServer}. */
export interface RpcServer {
  address(): RpcServerAddress | undefined;
  start(): Promise<RpcServerAddress>;
  stop(): Promise<void>;
}

interface ResolvedRpcServerOptions {
  acquireLock: (statePath: string) => Promise<RpcServerLock>;
  handlers: RpcServerHandlers;
  headersTimeoutMs: number;
  host: string;
  maxRequestBytes: number;
  port: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  statePath: string;
}

class RequestError extends Error {
  declare statusCode: number;

  constructor(statusCode: number) {
    super(`HTTP request rejected with status ${statusCode}`);
    this.statusCode = statusCode;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function validateOptions(options: unknown): ResolvedRpcServerOptions {
  if (!isObject(options)) {
    throw new Error('RPC server options must be an object');
  }
  if (
    options.handlers === null ||
    typeof options.handlers !== 'object' ||
    typeof (options.handlers as Record<string, unknown>).handle !== 'function' ||
    typeof (options.handlers as Record<string, unknown>).recoverStartup !== 'function'
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
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) {
    throw new Error('RPC server port must be an integer from 0 to 65535');
  }
  if (typeof acquireLock !== 'function') {
    throw new Error('RPC server acquireLock must be a function');
  }

  return Object.freeze({
    acquireLock: acquireLock as (statePath: string) => Promise<RpcServerLock>,
    handlers: options.handlers as RpcServerHandlers,
    headersTimeoutMs: validatePositiveInteger(
      options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
      'RPC server headersTimeoutMs',
    ),
    host,
    maxRequestBytes: validatePositiveInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'RPC server maxRequestBytes',
    ),
    port: port as number,
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

function sendEmpty(
  response: http.ServerResponse,
  statusCode: number,
  headers?: Record<string, string>,
  callback?: () => void,
): void {
  if (response.destroyed || response.writableEnded) {
    callback?.();
    return;
  }
  response.writeHead(statusCode, { 'content-length': '0', ...headers });
  response.end(callback);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function isSupportedContentType(value: unknown): boolean {
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

function isSupportedContentEncoding(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().toLowerCase() === 'identity');
}

function declaredBodySize(request: http.IncomingMessage): number | undefined {
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

function readBody(request: http.IncomingMessage, maxRequestBytes: number, requestTimeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
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

    function finish(error?: Error, body?: Buffer) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve(body as Buffer);
      } else {
        reject(error);
      }
    }

    function onAborted() {
      finish(new RequestError(400));
    }

    function onData(chunk: Buffer) {
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

function responseId(payload: unknown): string | number | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const id = (payload as Record<string, unknown>).id;
  return id === null || typeof id === 'string' || typeof id === 'number' ? id : null;
}

function internalError(payload: unknown) {
  return {
    jsonrpc: '2.0',
    id: responseId(payload),
    error: { code: -32_603, message: 'Internal error' },
  };
}

function isNotification(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(key => !['jsonrpc', 'method', 'params'].includes(key)) ||
    record.jsonrpc !== '2.0' ||
    typeof record.method !== 'string' ||
    record.method.length === 0
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(record, 'id')) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'params')) {
    return true;
  }
  return (
    Array.isArray(record.params) ||
    (record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params))
  );
}

function internalFailure(payload: unknown) {
  if (isNotification(payload)) {
    return undefined;
  }
  if (!Array.isArray(payload)) {
    return internalError(payload);
  }
  if (payload.length === 0) {
    return internalError(null);
  }
  const responses = payload.filter(item => !isNotification(item)).map(item => internalError(item));
  return responses.length === 0 ? undefined : responses;
}

function sendInternalFailure(response: http.ServerResponse, payload: unknown): void {
  const failure = internalFailure(payload);
  if (failure === undefined) {
    sendEmpty(response, 204);
  } else {
    sendJson(response, 200, failure);
  }
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)));
  });
}

function createRpcServer(rawOptions: unknown): RpcServer {
  const options = validateOptions(rawOptions);
  const sockets = new Set<Socket>();
  const inFlight = new Set<Promise<unknown>>();
  let address: RpcServerAddress | undefined;
  let lock: RpcServerLock | undefined;
  let phase: 'idle' | 'starting' | 'ready' | 'draining' | 'stopped' = 'idle';
  let releasePromise: Promise<void> | undefined;
  let startPromise: Promise<RpcServerAddress> | undefined;
  let stopPromise: Promise<void> | undefined;

  async function handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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
      sendEmpty(response, (error as RequestError).statusCode ?? 400, { connection: 'close' }, () =>
        request.destroy(),
      );
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
      payload = JSON.parse(UTF8_DECODER.decode(body));
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
      sendInternalFailure(response, payload);
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
        sendInternalFailure(response, payload);
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

  function releaseLock(): Promise<void> {
    if (lock === undefined) {
      return Promise.resolve();
    }
    if (releasePromise === undefined) {
      releasePromise = Promise.resolve().then(() => (lock as RpcServerLock).release());
    }
    return releasePromise;
  }

  function listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      function onError(error: Error) {
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

  function start(): Promise<RpcServerAddress> {
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
        const bound = server.address() as AddressInfo;
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

  function stop(): Promise<void> {
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

export { createRpcServer };
