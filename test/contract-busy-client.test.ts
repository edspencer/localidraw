// From edspencer/cli-contract test/busy-client.test.ts @ 1.0; local changes: imports from server/contract/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  busyExitCode,
  busyJson,
  busyMessage,
  checkBusy,
  describeCounts,
  guardBusy,
  runBusyCommand,
} from '../server/contract/busy-client.ts';
import { createOutput } from '../server/contract/output.ts';
import { writeRuntimeFile } from '../server/contract/runtime-file.ts';
import { capture, tempDir } from './contract-helpers.ts';

let answer: { status: number; body: string } = { status: 200, body: '{"busy":false,"version":"1.0.0","counts":{}}' };
const server = http.createServer((req, res) => {
  if (req.url !== '/api/busy') return void res.writeHead(404).end();
  res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const url = `http://127.0.0.1:${port}`;
after(() => server.close());

function homeWithInstance(): string {
  const home = tempDir();
  writeRuntimeFile(home, { pid: process.pid, port, url, version: '1.0.0' });
  return home;
}

test('counts become a sentence', () => {
  assert.equal(describeCounts({}), '');
  assert.equal(describeCounts({ chat: 0, job: 0 }), '');
  assert.equal(describeCounts({ chat: 1 }), '1 chat is running');
  assert.equal(describeCounts({ chat: 2, job: 1 }), '2 chats and 1 job are running');
  assert.equal(describeCounts({ chat: 1, job: 2, import: 1 }), '1 chat, 2 jobs and 1 import are running');
  assert.equal(describeCounts({ batch: 2 }, { batch: ['batch', 'batches'] }), '2 batches are running');
});

test('no runtime.json: not running, exit 3, without asking any port', async () => {
  const r = await checkBusy({ home: tempDir(), fetch: () => assert.fail('nothing should be asked') });
  assert.deepEqual(r, { state: 'not-running' });
  assert.equal(busyExitCode(r), 3);
  assert.equal(busyMessage('Paddock', r), "Paddock isn't running.");
  assert.deepEqual(busyJson(r), { running: false, busy: false });
});

test('a stale runtime.json, or nothing listening: not running', async () => {
  const home = tempDir();
  writeRuntimeFile(home, { pid: process.pid, port: 1, url: 'http://127.0.0.1:1', version: '1.0.0' });
  assert.equal((await checkBusy({ home })).state, 'not-running');
});

test('idle: exit 0', async () => {
  answer = { status: 200, body: '{"busy":false,"version":"1.0.0","counts":{"chat":0}}' };
  const r = await checkBusy({ home: homeWithInstance() });
  assert.equal(r.state, 'idle');
  assert.equal(busyExitCode(r), 0);
  assert.equal(busyMessage('Paddock', r), "Paddock isn't busy.");
  assert.deepEqual(busyJson(r), { running: true, busy: false, url, version: '1.0.0', counts: { chat: 0 } });
});

test('busy: exit 75, and the message names the work', async () => {
  answer = { status: 200, body: '{"busy":true,"version":"1.0.0","counts":{"chat":2,"job":1}}' };
  const r = await checkBusy({ home: homeWithInstance() });
  assert.equal(busyExitCode(r), 75);
  assert.equal(busyMessage('Paddock', r), 'Paddock is busy: 2 chats and 1 job are running.');
});

test('an answer that is not a busy answer: exit 1, saying what answered', async () => {
  answer = { status: 404, body: 'no' };
  const r = await checkBusy({ home: tempDir(), url });
  assert.equal(r.state, 'unknown');
  assert.equal(busyExitCode(r), 1);
  assert.match(busyMessage('Paddock', r), /HTTP 404/);
  answer = { status: 200, body: '{"ok":true}' };
  assert.equal((await checkBusy({ home: tempDir(), url })).state, 'unknown');
});

test('`busy --json` prints one document; prose goes to stderr', async () => {
  answer = { status: 200, body: '{"busy":true,"counts":{"save":1}}' };
  const stdout = capture();
  const stderr = capture();
  const code = await runBusyCommand({ home: homeWithInstance(), name: 'Localidraw', out: createOutput({ tool: 'localidraw', json: true, stdout, stderr, env: {} }) });
  assert.equal(code, 75);
  assert.deepEqual(JSON.parse(stdout.text), { running: true, busy: true, url, counts: { save: 1 } });
  assert.equal(stderr.text, 'Localidraw is busy: 1 save is running.\n');
});

test('the guard refuses with 75, or overrides with --force', async () => {
  answer = { status: 200, body: '{"busy":true,"counts":{"chat":1}}' };
  const home = homeWithInstance();
  let stderr = capture();
  const out = () => createOutput({ tool: 'paddock', stdout: capture(), stderr, env: {} });
  assert.equal(await guardBusy({ home, name: 'Paddock', out: out() }), 75);
  assert.equal(stderr.text, 'paddock: Paddock is busy: 1 chat is running. Try again once it has finished, or use --force.\n');
  stderr = capture();
  assert.equal(await guardBusy({ home, name: 'Paddock', out: out(), force: true }), null);
  assert.equal(stderr.text, 'Overriding: Paddock is busy: 1 chat is running.\n');
  answer = { status: 200, body: '{"busy":false}' };
  assert.equal(await guardBusy({ home, name: 'Paddock', out: out() }), null);
  assert.equal(await guardBusy({ home: tempDir(), name: 'Paddock', out: out() }), null, 'nothing running goes ahead');
});
