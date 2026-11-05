// From edspencer/cli-contract test/runtime-file.test.ts @ 0.2; local changes: imports from server/contract/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPidAlive,
  readLiveRuntimeFile,
  readRuntimeFile,
  removeRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from '../server/contract/runtime-file.ts';
import { tempDir } from './contract-helpers.ts';

test('writes and reads back { pid, port, url, version, startedAt }, creating the home', () => {
  const home = path.join(tempDir(), 'nested', '.tool');
  const written = writeRuntimeFile(home, { pid: process.pid, port: 3729, url: 'http://127.0.0.1:3729', version: '1.2.3' });
  assert.match(written.startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(readRuntimeFile(home), written);
  assert.deepEqual(Object.keys(written), ['pid', 'port', 'url', 'version', 'startedAt']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(runtimeFilePath(home)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home), ['runtime.json'], 'no temporary file left behind');
});

test('a missing, half-written or foreign file reads as null', () => {
  const home = tempDir();
  assert.equal(readRuntimeFile(home), null);
  fs.writeFileSync(runtimeFilePath(home), '{"pid": 12');
  assert.equal(readRuntimeFile(home), null);
  fs.writeFileSync(runtimeFilePath(home), JSON.stringify({ pid: 'x', port: 1, url: 'u', version: 'v', startedAt: 's' }));
  assert.equal(readRuntimeFile(home), null);
});

test('removes the file only for the pid that wrote it', () => {
  const home = tempDir();
  writeRuntimeFile(home, { pid: 999_999, port: 1, url: 'http://127.0.0.1:1', version: '1.0.0' });
  assert.equal(removeRuntimeFile(home, process.pid), false);
  assert.ok(fs.existsSync(runtimeFilePath(home)));
  assert.equal(removeRuntimeFile(home, 999_999), true);
  assert.equal(fs.existsSync(runtimeFilePath(home)), false);
  assert.equal(removeRuntimeFile(home), false);
});

test('a dead pid makes the file stale', () => {
  const home = tempDir();
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  writeRuntimeFile(home, { pid: process.pid, port: 1, url: 'http://127.0.0.1:1', version: '1.0.0' });
  assert.ok(readLiveRuntimeFile(home));
  // Find a pid that isn't in use.
  let dead = 2_000_000;
  while (isPidAlive(dead)) dead++;
  writeRuntimeFile(home, { pid: dead, port: 1, url: 'http://127.0.0.1:1', version: '1.0.0' });
  assert.equal(readLiveRuntimeFile(home), null);
});
