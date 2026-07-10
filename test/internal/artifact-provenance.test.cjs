'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInfoDirectory, isAbsolutePath, resolvePath } = require('../../src/internal/artifact-provenance.cjs');

test('classifies portable absolute path forms', () => {
  assert.equal(isAbsolutePath('/tmp/project/out'), true);
  assert.equal(isAbsolutePath('C:/project/out'), true);
  assert.equal(isAbsolutePath('C:\\project\\out'), true);
  assert.equal(isAbsolutePath('\\\\server\\share\\out'), true);
  assert.equal(isAbsolutePath('project/out'), false);
});

test('resolves relative paths without corrupting Windows absolute paths', () => {
  assert.equal(resolvePath('out', '/tmp/project'), '/tmp/project/out');
  assert.equal(resolvePath('C:/project/out', '/tmp/project'), 'C:\\project\\out');
  assert.equal(resolvePath('C:\\project\\out', '/tmp/project'), 'C:\\project\\out');
  assert.equal(resolvePath('\\\\server\\share\\out', '/tmp/project'), '\\\\server\\share\\out');
});

test('selects split build-info beside artifacts contracts for Windows paths', () => {
  assert.equal(buildInfoDirectory('C:/project/artifacts/contracts'), 'C:\\project\\artifacts\\build-info');
  assert.equal(
    buildInfoDirectory('\\\\server\\share\\project\\artifacts\\contracts'),
    '\\\\server\\share\\project\\artifacts\\build-info',
  );
});
