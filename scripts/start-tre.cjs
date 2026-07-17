'use strict';

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_IMAGE = 'tronbox/tre:dev';
const TRE_ENVIRONMENT = Object.freeze({
  accounts: '10',
  defaultBalance: '1000000000',
  mnemonic: 'test test test test test test test test test test test junk',
  hdPath: "m/44'/60'/0'/0",
  quiet: 'true',
  JAVA_TOOL_OPTIONS: '-XX:+UseG1GC -XX:MaxGCPauseMillis=20 -Xmx2g -Xms512m -XX:+AlwaysPreTouch -XX:+TieredCompilation',
});

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Docker ${args[0]} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  return result.stdout.trim();
}

function startTre(options = {}) {
  const image = options.image ?? DEFAULT_IMAGE;
  if (typeof image !== 'string' || image.length === 0) throw new Error('Invalid TRE image');
  const containerName = options.containerName ?? `openzeppelin-foundry-tre-${process.pid}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(containerName)) throw new Error('Invalid TRE container name');
  const environmentArguments = Object.entries(TRE_ENVIRONMENT).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  docker(['run', '-d', '--rm', '--name', containerName, '-p', '127.0.0.1::9090', ...environmentArguments, image]);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const result = spawnSync('docker', ['stop', '--time', '5', containerName], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0 && !/No such container/i.test(result.stderr || '')) {
      throw new Error(`Docker stop failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
    }
  };
  try {
    const published = docker(['port', containerName, '9090/tcp']);
    const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):([0-9]+)$/.exec(published.split('\n')[0]);
    if (match === null) throw new Error(`Cannot determine TRE port from ${published}`);
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('Invalid published TRE port');
    return Object.freeze({
      containerName,
      endpoint: `http://127.0.0.1:${port}`,
      image,
      port,
      stop,
    });
  } catch (error) {
    stop();
    throw error;
  }
}

if (require.main === module) {
  try {
    const tre = startTre({ image: process.env.TRE_IMAGE ?? DEFAULT_IMAGE });
    process.stdout.write(
      `${JSON.stringify({ containerName: tre.containerName, endpoint: tre.endpoint, image: tre.image })}\n`,
    );
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { DEFAULT_IMAGE, TRE_ENVIRONMENT, startTre };
