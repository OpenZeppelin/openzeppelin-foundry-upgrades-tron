const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const LOOPBACK_HOST = '127.0.0.1';
const DYNAMIC_PORT_FIRST = 49_152;
const DYNAMIC_PORT_COUNT = 16_384;
const CANDIDATE_COUNT = 8;
const DEFAULT_PROBE_TIMEOUT_MS = 200;
const MAX_PROTOCOL_MESSAGE_BYTES = 160;
const PROTOCOL_PREFIX = 'OPENZEPPELIN_FOUNDRY_TRON_STATE_LOCK_V1';

const capabilityRecords = new WeakMap();

function canonicalStatePath(statePath) {
  if (typeof statePath !== 'string' || statePath.length === 0 || statePath.includes('\0')) {
    throw new Error('State path must be a nonempty filesystem path');
  }

  const absolutePath = path.resolve(statePath);
  const missingSegments = [];
  let existingAncestor = absolutePath;

  for (;;) {
    try {
      const canonicalAncestor = fs.realpathSync.native(existingAncestor);
      return path.join(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }

      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function stateIdentity(statePath) {
  return crypto.createHash('sha256').update(canonicalStatePath(statePath), 'utf8').digest();
}

function deriveCandidatePorts(stateId) {
  const ports = [];
  const selected = new Set();
  let counter = 0;

  while (ports.length < CANDIDATE_COUNT) {
    const digest = crypto
      .createHash('sha256')
      .update(stateId)
      .update(Buffer.from(`:${counter}`, 'ascii'))
      .digest();
    const port = DYNAMIC_PORT_FIRST + (digest.readUInt16BE(0) % DYNAMIC_PORT_COUNT);
    if (!selected.has(port)) {
      selected.add(port);
      ports.push(port);
    }
    counter += 1;
  }

  return ports;
}

function validateCandidatePorts(candidatePorts) {
  if (
    !Array.isArray(candidatePorts) ||
    candidatePorts.length !== CANDIDATE_COUNT ||
    candidatePorts.some(port => !Number.isInteger(port) || port < 1 || port > 65_535) ||
    new Set(candidatePorts).size !== CANDIDATE_COUNT
  ) {
    throw new Error('State lock candidatePorts must contain exactly 8 distinct TCP ports');
  }
  return [...candidatePorts];
}

function validateProbeTimeout(probeTimeoutMs) {
  if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 10_000) {
    throw new Error('State lock probeTimeoutMs must be an integer from 1 to 10000');
  }
  return probeTimeoutMs;
}

function proofFor(stateId, nonce) {
  return crypto.createHmac('sha256', stateId).update(nonce, 'hex').digest('hex');
}

function createLockServer(stateId, sockets) {
  return net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(DEFAULT_PROBE_TIMEOUT_MS, () => socket.destroy());

    let request = '';
    socket.on('data', chunk => {
      request += chunk;
      if (Buffer.byteLength(request, 'utf8') > MAX_PROTOCOL_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }

      if (!request.includes('\n')) {
        return;
      }

      const match = new RegExp(`^${PROTOCOL_PREFIX} PROBE ([0-9a-f]{64})\\n$`).exec(request);
      if (match === null) {
        socket.destroy();
        return;
      }

      socket.end(`${PROTOCOL_PREFIX} HELD ${proofFor(stateId, match[1])}\n`);
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
}

async function bindCandidate(port, stateId, sockets) {
  const server = createLockServer(stateId, sockets);

  return new Promise((resolve, reject) => {
    function onError(error) {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        resolve(undefined);
      } else {
        reject(error);
      }
    }

    function onListening() {
      server.removeListener('error', onError);
      resolve(server);
    }

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ exclusive: true, host: LOOPBACK_HOST, port });
  });
}

async function probeCandidate(port, stateId, timeoutMs) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expectedResponse = `${PROTOCOL_PREFIX} HELD ${proofFor(stateId, nonce)}\n`;

  return new Promise(resolve => {
    const socket = net.createConnection({ host: LOOPBACK_HOST, port });
    let response = '';
    let settled = false;

    function finish(matches) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(matches);
    }

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('connect', () => socket.end(`${PROTOCOL_PREFIX} PROBE ${nonce}\n`));
    socket.on('data', chunk => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > MAX_PROTOCOL_MESSAGE_BYTES) {
        finish(false);
      }
    });
    socket.on('end', () => finish(response === expectedResponse));
    socket.on('close', () => finish(response === expectedResponse));
    socket.on('error', () => finish(false));
  });
}

function assertStateLockHeld(capability) {
  const record = capabilityRecords.get(capability);
  if (record === undefined) {
    throw new Error('Expected an authentic state lock capability');
  }
  if (!record.held || !record.server.listening) {
    throw new Error('State lock is no longer held');
  }
  return capability;
}

async function releaseStateLock(capability) {
  const record = capabilityRecords.get(capability);
  if (record === undefined) {
    throw new Error('Expected an authentic state lock capability');
  }
  if (!record.held) {
    return;
  }

  record.held = false;
  for (const socket of record.sockets) {
    socket.destroy();
  }

  if (record.server.listening) {
    await new Promise((resolve, reject) => {
      record.server.close(error => (error === undefined ? resolve() : reject(error)));
    });
  }
}

function createCapability(server, sockets, port) {
  let capability;
  capability = Object.freeze({
    ownerId: crypto.randomBytes(32).toString('hex'),
    port,
    assertHeld() {
      return assertStateLockHeld(capability);
    },
    release() {
      return releaseStateLock(capability);
    },
  });

  const record = { held: true, server, sockets };
  capabilityRecords.set(capability, record);
  server.once('close', () => {
    record.held = false;
  });
  server.on('error', () => {
    record.held = false;
  });
  server.unref();
  return capability;
}

async function acquireStateLock(statePath, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('State lock options must be an object');
  }

  const stateId = stateIdentity(statePath);
  const candidatePorts =
    options.candidatePorts === undefined
      ? deriveCandidatePorts(stateId)
      : validateCandidatePorts(options.candidatePorts);
  const probeTimeoutMs = validateProbeTimeout(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  for (const port of candidatePorts) {
    const sockets = new Set();
    const server = await bindCandidate(port, stateId, sockets);
    if (server !== undefined) {
      return createCapability(server, sockets, port);
    }

    if (await probeCandidate(port, stateId, probeTimeoutMs)) {
      throw new Error('State is already locked by another adapter process');
    }
  }

  throw new Error('Unable to acquire the state lock because all 8 candidate ports are occupied');
}

module.exports = {
  acquireStateLock,
  assertStateLockHeld,
};
