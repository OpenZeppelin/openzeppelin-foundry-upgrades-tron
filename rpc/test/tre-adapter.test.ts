import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import { ContractFactory, Interface, Wallet, getCreateAddress, keccak256 } from 'ethers';
import { TronWeb } from 'tronweb';

import { toTronHexAddress } from '../../dist/rpc/address-codec.js';
import { buildRuntime } from '../../dist/rpc/cli.js';
import type { AdapterRuntime } from '../../dist/rpc/cli.js';
import { DEFAULT_CHAIN_ID, DEFAULT_TRE_PRIVATE_KEY, parseConfig } from '../../dist/rpc/config.js';
import type { Config } from '../../dist/rpc/config.js';

// These two helper scripts are not part of the rpc-src TypeScript migration (they stay `.cjs`), so
// they are required directly rather than imported.
const { startTre, TRE_ENVIRONMENT } = require('../../scripts/start-tre.cjs');
const { waitForTre } = require('../../scripts/wait-for-tre.cjs');

// Foundry-compiled artifacts, TRON/JSON-RPC responses, and other externally-sourced JSON this test
// constructs and inspects are deliberately loosely shaped, mirroring how rpc-src/cli.ts and its
// siblings handle such dynamically-shaped data at runtime. `any` is used deliberately throughout
// this file for that content, matching rpc-src/cli.ts's own handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const RUN_TRE = process.env.RUN_TRE_E2E === '1';
const execFileAsync = promisify(execFile);
const COUNTER_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;
contract Counter {
    uint256 public value;
    constructor(uint256 initialValue) { value = initialValue; }
    function set(uint256 nextValue) external { value = nextValue; }
}`;

async function unusedLoopbackEndpoint(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return `http://127.0.0.1:${port}`;
}

async function rpc(url: string, method: string, params: unknown[] = [], id: number = 1): Promise<JsonAny> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200);
  const body: JsonAny = await response.json();
  if (body.error !== undefined)
    throw new Error(`${method}: ${body.error.message} (${body.error.data?.code ?? body.error.code})`);
  return body.result;
}

function compileCounter(directory: string): { artifact: JsonAny; out: string } {
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'foundry.toml'),
    '[profile.default]\nsrc = "src"\nout = "out"\nsolc_version = "0.8.22"\nast = true\nbuild_info = true\nextra_output = ["storageLayout"]\n',
  );
  fs.writeFileSync(path.join(directory, 'src', 'Counter.sol'), COUNTER_SOURCE);
  const result = spawnSync('forge', ['build', '--root', directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(path.join(directory, 'out', 'Counter.sol', 'Counter.json'), 'utf8'));
  return { artifact, out: path.join(directory, 'out') };
}

async function startAdapter(config: Config): Promise<{ runtime: AdapterRuntime; url: string }> {
  const runtime = buildRuntime(config, { host: '127.0.0.1', port: 0 });
  const simulationMode = await runtime.nativeClient.assertSimulationReady();
  assert.equal(simulationMode, 'constant-create');
  const address = await runtime.server.start();
  return { runtime, url: `http://${address.host}:${address.port}` };
}

test('TRE readiness reports an unavailable endpoint within its deadline', async () => {
  const endpoint = await unusedLoopbackEndpoint();
  const started = Date.now();
  await assert.rejects(
    () => waitForTre({ endpoint, timeoutMs: 120, pollIntervalMs: 20, privateKey: DEFAULT_TRE_PRIVATE_KEY }),
    /TRE.*not ready.*120ms/i,
  );
  assert.ok(Date.now() - started < 1_000);
});

test('TRE lifecycle pins the deterministic Hardhat-compatible development accounts', () => {
  assert.deepEqual(TRE_ENVIRONMENT, {
    accounts: '10',
    defaultBalance: '1000000000',
    mnemonic: 'test test test test test test test test test test test junk',
    hdPath: "m/44'/60'/0'/0",
    quiet: 'true',
    JAVA_TOOL_OPTIONS:
      '-XX:+UseG1GC -XX:MaxGCPauseMillis=20 -Xmx2g -Xms512m -XX:+AlwaysPreTouch -XX:+TieredCompilation',
  });
  assert.equal(TronWeb.address.fromPrivateKey(DEFAULT_TRE_PRIVATE_KEY), 'TCjgri5AfebbWEo8DXweGE3qHtMEMVqm9r');
});

test(
  'stock TRE translates sequential legacy deployments, calls, restart, replay, and native state',
  { skip: !RUN_TRE, timeout: 240_000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-tre-adapter-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const tre = startTre();
    t.after(() => tre.stop());
    await waitForTre({ endpoint: tre.endpoint, timeoutMs: 75_000, privateKey: DEFAULT_TRE_PRIVATE_KEY });

    const { artifact, out } = compileCounter(path.join(directory, 'project'));
    const stateFile = path.join(directory, 'state.json');
    const config = parseConfig({
      FOUNDRY_OUT: out,
      TRON_CHAIN_ID: DEFAULT_CHAIN_ID.toString(),
      TRON_NETWORK: 'tre',
      TRON_PRIVATE_KEY: DEFAULT_TRE_PRIVATE_KEY,
      TRON_RPC_URL: tre.endpoint,
      TRON_STATE_FILE: stateFile,
    });
    const wallet = new Wallet(DEFAULT_TRE_PRIVATE_KEY);
    assert.equal(wallet.address.toLowerCase(), config.expectedSender);
    assert.equal(await rpc(`${tre.endpoint}/jsonrpc`, 'eth_chainId'), `0x${DEFAULT_CHAIN_ID.toString(16)}`);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
    const firstDeploy = await factory.getDeployTransaction(11n);
    const secondDeploy = await factory.getDeployTransaction(22n);
    const legacy = (transaction: JsonAny) =>
      wallet.signTransaction({
        chainId: DEFAULT_CHAIN_ID,
        gasLimit: 12_000_000,
        gasPrice: 1,
        type: 0,
        ...transaction,
      });
    const firstRaw = await legacy({ nonce: 0, data: firstDeploy.data });
    const secondRaw = await legacy({ nonce: 1, data: secondDeploy.data });
    const firstHash = keccak256(firstRaw);
    const secondHash = keccak256(secondRaw);
    const firstPredicted = getCreateAddress({ from: wallet.address, nonce: 0 }).toLowerCase();
    const secondPredicted = getCreateAddress({ from: wallet.address, nonce: 1 }).toLowerCase();

    let adapter = await startAdapter(config);
    t.after(async () => adapter.runtime.server.stop());
    assert.equal(await rpc(adapter.url, 'net_version'), DEFAULT_CHAIN_ID.toString(10));
    const head = await rpc(`${tre.endpoint}/jsonrpc`, 'eth_blockNumber');
    for (const [method, address] of [
      ['eth_getBalance', wallet.address],
      ['eth_getCode', `0x${'00'.repeat(20)}`],
    ]) {
      assert.equal(
        await rpc(adapter.url, method, [address, head]),
        await rpc(`${tre.endpoint}/jsonrpc`, method, [address, 'latest']),
      );
    }
    const castBlock = await execFileAsync('cast', ['block', 'latest', '--rpc-url', adapter.url, '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(JSON.parse(castBlock.stdout).stateRoot, `0x${'00'.repeat(32)}`);
    assert.equal(await rpc(adapter.url, 'eth_getTransactionCount', [wallet.address, 'latest']), '0x0');
    assert.equal(await rpc(adapter.url, 'eth_getTransactionCount', [wallet.address, 'pending']), '0x0');
    assert.equal(await rpc(adapter.url, 'eth_sendRawTransaction', [firstRaw]), firstHash);
    assert.equal(await rpc(adapter.url, 'eth_getTransactionCount', [wallet.address, 'latest']), '0x1');
    assert.equal(await rpc(adapter.url, 'eth_sendRawTransaction', [secondRaw]), secondHash);
    assert.equal(await rpc(adapter.url, 'eth_getTransactionCount', [wallet.address, 'pending']), '0x2');
    const firstReceipt = await rpc(adapter.url, 'eth_getTransactionReceipt', [firstHash]);
    const secondReceipt = await rpc(adapter.url, 'eth_getTransactionReceipt', [secondHash]);
    assert.equal(firstReceipt.status, '0x1');
    assert.equal(secondReceipt.status, '0x1');
    assert.equal(firstReceipt.contractAddress, firstPredicted);
    assert.equal(secondReceipt.contractAddress, secondPredicted);

    const firstResolution = await rpc(adapter.url, 'tron_resolveAddress', [firstPredicted]);
    const secondResolution = await rpc(adapter.url, 'tron_resolveAddress', [secondPredicted]);
    assert.notEqual(firstResolution.actual, firstPredicted);
    assert.notEqual(secondResolution.actual, secondPredicted);
    assert.notEqual(firstResolution.actual, secondResolution.actual);

    const counter = new Interface(artifact.abi);
    const valueCall = counter.encodeFunctionData('value');
    assert.equal(BigInt(await rpc(adapter.url, 'eth_call', [{ to: firstPredicted, data: valueCall }, 'latest'])), 11n);
    assert.equal(BigInt(await rpc(adapter.url, 'eth_call', [{ to: secondPredicted, data: valueCall }, 'latest'])), 22n);

    const setRaw = await legacy({ nonce: 2, to: firstPredicted, data: counter.encodeFunctionData('set', [77n]) });
    const setHash = keccak256(setRaw);
    assert.equal(await rpc(adapter.url, 'eth_sendRawTransaction', [setRaw]), setHash);
    assert.equal((await rpc(adapter.url, 'eth_getTransactionReceipt', [setHash])).status, '0x1');
    assert.equal(BigInt(await rpc(adapter.url, 'eth_call', [{ to: firstPredicted, data: valueCall }, 'latest'])), 77n);

    const tronWeb = new TronWeb({ fullHost: tre.endpoint, privateKey: DEFAULT_TRE_PRIVATE_KEY });
    const firstNative = await tronWeb.contract(artifact.abi, toTronHexAddress(firstResolution.actual));
    const secondNative = await tronWeb.contract(artifact.abi, toTronHexAddress(secondResolution.actual));
    assert.equal(BigInt(await firstNative.value().call()), 77n);
    assert.equal(BigInt(await secondNative.value().call()), 22n);

    await adapter.runtime.server.stop();
    adapter = await startAdapter(config);
    assert.equal(await rpc(adapter.url, 'eth_getTransactionCount', [wallet.address, 'latest']), '0x3');
    assert.equal(await rpc(adapter.url, 'eth_getTransactionCount', [wallet.address, 'pending']), '0x3');
    assert.equal(await rpc(adapter.url, 'eth_sendRawTransaction', [firstRaw]), firstHash);
    assert.deepEqual(await rpc(adapter.url, 'eth_getTransactionReceipt', [firstHash]), firstReceipt);
    assert.deepEqual(await rpc(adapter.url, 'eth_getTransactionReceipt', [secondHash]), secondReceipt);
    assert.equal(BigInt(await rpc(adapter.url, 'eth_call', [{ to: firstPredicted, data: valueCall }, 'latest'])), 77n);
    assert.equal(BigInt(await firstNative.value().call()), 77n);
  },
);
