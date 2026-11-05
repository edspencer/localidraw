// From edspencer/cli-contract test/service.test.ts @ 1.0; local changes: imports from server/contract/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lingerAdvice, serviceManagerFor, UnsupportedPlatformError } from '../server/contract/service/index.ts';
import {
  BOOTOUT_POLLS,
  createLaunchd,
  parseLaunchctlPrint,
  parsePlistArgv,
  parsePlistLogPath,
  plistKeepsAlive,
  plistPath,
  renderPlist,
} from '../server/contract/service/launchd.ts';
import type { RunResult, Runner, ServiceIdentity, ServiceSpec } from '../server/contract/service/manager.ts';
import { missingPaths, servicePath, which } from '../server/contract/service/path-env.ts';
import { argValue, buildSpec, serviceLogPath } from '../server/contract/service/spec.ts';
import { createSystemd, execWord, execWords, parseUnitArgv, parseUnitLogPath, renderUnit, systemctlFailure, unitKeepsAlive, unitPath } from '../server/contract/service/systemd.ts';
import { followFile, sizeOf, tailFile } from '../server/contract/service/logs.ts';
import { tempDir } from './contract-helpers.ts';

const ID: ServiceIdentity = {
  name: 'Tool',
  tool: 'tool',
  label: 'net.example.tool',
  unit: 'tool.service',
  description: 'Tool, as a service',
  documentation: 'https://tool.example',
};

function spec(home: string, over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    nodePath: '/opt/node 22/bin/node',
    scriptPath: '/usr/lib/node_modules/tool/dist/cli.js',
    args: ['serve', '--port', '7000', '--home', '/srv/50%/$HOME'],
    workingDirectory: path.join(home, 'service'),
    logPath: serviceLogPath(home),
    pathEnv: '/opt/node 22/bin:/usr/bin',
    ...over,
  };
}

/** A fake service manager: records each call, and answers from `script` by the command's first word. */
function fake(script: (cmd: string, args: string[]) => Partial<RunResult> | undefined = () => undefined) {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '', ...script(cmd, args) };
  };
  return { calls, run };
}

// ---- spec and PATH

test('the spec realpaths Node and the script, and puts the log and working folder under the home', () => {
  const s = buildSpec({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/usr/local/bin/tool',
    args: ['serve', '--port', '7000'],
    home: '/h/.tool',
    pathEnv: ['/x/fnm_multishells/123_4/bin', '/usr/bin'].join(path.delimiter),
    realpath: (p) => (p === '/usr/local/bin/node' ? '/opt/node/bin/node' : '/usr/local/lib/node_modules/tool/dist/cli.js'),
    exists: () => true,
    systemDirs: ['/bin'],
  });
  assert.deepEqual(s, {
    nodePath: '/opt/node/bin/node',
    scriptPath: '/usr/local/lib/node_modules/tool/dist/cli.js',
    args: ['serve', '--port', '7000'],
    workingDirectory: path.join('/h/.tool', 'service'),
    logPath: path.join('/h/.tool', 'logs', 'service.log'),
    pathEnv: ['/opt/node/bin', '/usr/bin', '/bin'].join(path.delimiter),
  });
});

test("the service's PATH: Node's folder first, no per-shell entries, only folders that exist, no duplicates", { skip: path.delimiter !== ':' && 'POSIX paths' }, () => {
  const exists = (p: string) => !p.includes('gone');
  const inherited = ['/home/u/.local/state/fnm_multishells/1_2/bin', '/home/u/.npm/_npx/9/node_modules/.bin', 'relative/bin', '/gone/bin', '/usr/bin/', '/opt/tools/bin', '/usr/bin'].join(':');
  assert.equal(servicePath('/opt/node/bin', inherited, { exists, systemDirs: ['/usr/local/bin', '/usr/bin'] }), '/opt/node/bin:/usr/bin:/opt/tools/bin:/usr/local/bin');
  assert.equal(which('sh', '/nope:/bin', (p) => p === '/bin/sh'), '/bin/sh');
  assert.deepEqual(missingPaths(['/a', undefined, '', '/b'], (p) => p === '/a'), ['/b']);
});

test("reads a flag's value back from a unit's arguments", () => {
  assert.equal(argValue(['serve', '--port', '7000'], ['--port', '-p']), '7000');
  assert.equal(argValue(['serve', '-p', '7001'], ['--port', '-p']), '7001');
  assert.equal(argValue(['serve', '--port=7002'], ['--port']), '7002');
  assert.equal(argValue(['serve', '--port'], ['--port']), undefined);
});

// ---- launchd

test('the plist: unconditional KeepAlive, one log for both streams, PATH and env, escaped', () => {
  const home = tempDir();
  const xml = renderPlist(ID, spec(home, { env: { TOOL_HOME: '/h/<x>' } }));
  assert.match(xml, /<key>Label<\/key>\n {4}<string>net\.example\.tool<\/string>/);
  assert.equal(plistKeepsAlive(xml), true);
  assert.equal(plistKeepsAlive(xml.replace('<key>KeepAlive</key>\n    <true/>', '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>')), false);
  assert.match(xml, /<key>ThrottleInterval<\/key>\n {4}<integer>10<\/integer>/);
  assert.equal(xml.split(`<string>${serviceLogPath(home)}</string>`).length, 3, 'StandardOutPath and StandardErrorPath name the same file');
  assert.match(xml, /<key>TOOL_HOME<\/key>\n {6}<string>\/h\/&lt;x&gt;<\/string>/);
  assert.deepEqual(parsePlistArgv(xml), ['/opt/node 22/bin/node', '/usr/lib/node_modules/tool/dist/cli.js', 'serve', '--port', '7000', '--home', '/srv/50%/$HOME']);
  assert.equal(parsePlistLogPath(xml), serviceLogPath(home));
  assert.equal(plistPath(ID, '/Users/u'), path.join('/Users/u', 'Library', 'LaunchAgents', 'net.example.tool.plist'));
});

test('launchctl print: running, and the pid', () => {
  assert.deepEqual(parseLaunchctlPrint('gui/501/x = {\n\tstate = running\n\tpid = 4242\n}'), { running: true, pid: '4242' });
  assert.deepEqual(parseLaunchctlPrint('\tstate = not running\n'), { running: false });
});

/** A launchd that knows whether the job is loaded, so `print` fails when it isn't (the trap C1 found). */
function fakeLaunchd(o: { stillLoadedPolls?: number; bootstrapFails?: number[] } = {}) {
  let loaded = false;
  let lingering = 0;
  const failures = [...(o.bootstrapFails ?? [])];
  const sleeps: number[] = [];
  const f = fake((cmd, args) => {
    if (args[0] === 'bootout') {
      if (!loaded) return { status: 3, stderr: 'Boot-out failed: 3: No such process' };
      loaded = false;
      lingering = o.stillLoadedPolls ?? 0;
      return {};
    }
    if (args[0] === 'print') {
      if (lingering > 0) {
        lingering--;
        return { status: 0, stdout: 'state = running' };
      }
      return loaded ? { status: 0, stdout: 'state = running\npid = 77\n' } : { status: 113, stderr: 'Could not find service' };
    }
    if (args[0] === 'bootstrap') {
      const code = failures.shift();
      if (code !== undefined) return { status: code, stderr: `Bootstrap failed: ${code}: Input/output error` };
      loaded = true;
    }
    return {};
  });
  const home = tempDir();
  const m = createLaunchd(ID, { run: f.run, homeDir: home, uid: 501, sleep: (ms) => void sleeps.push(ms) });
  return { ...f, m, home, sleeps, isLoaded: () => loaded };
}

test('launchd install: writes the plist, boots out, bootstraps into gui/<uid>, kickstarts', () => {
  const l = fakeLaunchd();
  l.m.install(spec(l.home));
  assert.ok(fs.existsSync(l.m.unitPath));
  assert.ok(fs.existsSync(path.join(l.home, 'logs')), "the log's folder exists before launchd needs it");
  assert.deepEqual(l.calls, [
    'launchctl bootout gui/501/net.example.tool',
    'launchctl print gui/501/net.example.tool',
    `launchctl bootstrap gui/501 ${l.m.unitPath}`,
    'launchctl kickstart -k gui/501/net.example.tool',
  ]);
  assert.deepEqual(l.sleeps, [], 'nothing was loaded, so nothing to wait for');
  const st = l.m.status();
  assert.deepEqual([st.registered, st.running, st.pid, st.argv[0], st.nodePath, st.keepsAlive], [true, true, '77', 'serve', '/opt/node 22/bin/node', true]);
});

test('the race: after a bootout, wait until launchd says the job has gone, then bootstrap', () => {
  const l = fakeLaunchd({ stillLoadedPolls: 3 });
  l.m.install(spec(l.home));
  l.calls.length = 0;
  l.m.restart();
  assert.deepEqual(l.calls.filter((c) => c.includes(' print ')).length, 4, 'three polls still loaded, the fourth gone');
  assert.deepEqual(l.sleeps, [250, 250, 250]);
  assert.ok(l.calls.indexOf(`launchctl bootstrap gui/501 ${l.m.unitPath}`) > l.calls.lastIndexOf('launchctl print gui/501/net.example.tool'));
});

test("the race: a bootstrap that fails with 5 or 37 is retried; another failure is reported at once, in launchctl's words", () => {
  const l = fakeLaunchd({ bootstrapFails: [5, 37] });
  l.m.start();
  assert.equal(l.calls.filter((c) => c.includes('bootstrap')).length, 3);
  assert.ok(l.isLoaded());
  assert.deepEqual(l.sleeps, [500, 500]);

  const bad = fakeLaunchd({ bootstrapFails: [112] });
  assert.throws(() => bad.m.start(), /launchctl bootstrap failed \(exit 112\): Bootstrap failed: 112/);
  assert.equal(bad.calls.filter((c) => c.includes('bootstrap')).length, 1, 'not retried');
});

test('neither wait is unbounded', () => {
  const stuck = fakeLaunchd({ stillLoadedPolls: 1000 });
  stuck.m.install(spec(stuck.home));
  stuck.calls.length = 0;
  stuck.sleeps.length = 0;
  stuck.m.stop();
  assert.equal(stuck.calls.filter((c) => c.includes(' print ')).length, BOOTOUT_POLLS);
  const always = fakeLaunchd({ bootstrapFails: [5, 5, 5, 5, 5, 5, 5] });
  assert.throws(() => always.m.start(), /exit 5/);
  assert.equal(always.calls.filter((c) => c.includes('bootstrap')).length, 6);
});

test("a first install launchd refuses leaves no plist behind; a refused reinstall keeps the plist it had", () => {
  const l = fakeLaunchd({ bootstrapFails: [112] });
  assert.throws(() => l.m.install(spec(l.home)), /launchctl bootstrap failed \(exit 112\)/);
  assert.equal(fs.existsSync(l.m.unitPath), false, 'status would otherwise say it is installed');
  assert.equal(l.m.status().registered, false);

  const again = fakeLaunchd({ bootstrapFails: [0, 112] });
  again.m.install(spec(again.home));
  assert.throws(() => again.m.install(spec(again.home, { args: ['serve', '--port', '7001'] })), /exit 112/);
  assert.ok(fs.existsSync(again.m.unitPath), 'a reinstall keeps its plist');
});

test("launchd stop boots out and waits, doesn't touch the plist, and is fine when nothing's loaded", () => {
  const l = fakeLaunchd();
  l.m.install(spec(l.home));
  l.m.stop();
  assert.equal(l.isLoaded(), false);
  assert.ok(fs.existsSync(l.m.unitPath), 'the plist stays: the next login starts it again');
  assert.deepEqual(l.m.status().running, false);
  assert.doesNotThrow(() => l.m.stop());
  const broken = fake((_, args) => (args[0] === 'bootout' ? { status: 1, stderr: 'Operation not permitted' } : args[0] === 'print' ? { status: 113 } : undefined));
  assert.throws(() => createLaunchd(ID, { run: broken.run, homeDir: tempDir(), sleep: () => {} }).stop(), /launchctl bootout failed \(exit 1\): Operation not permitted/);
});

test('launchd uninstall removes the plist and says whether there was one', () => {
  const l = fakeLaunchd();
  assert.equal(l.m.uninstall(), false);
  l.m.install(spec(l.home));
  assert.equal(l.m.uninstall(), true);
  assert.equal(fs.existsSync(l.m.unitPath), false);
  assert.deepEqual(l.m.status(), { registered: false, running: false, argv: [], keepsAlive: true });
  assert.deepEqual(l.m.linger(), { applies: false });
});

// ---- systemd

test('ExecStart words: specifiers and variables escaped, quoted when needed, and read back', () => {
  assert.equal(execWord('/usr/bin/node'), '/usr/bin/node');
  assert.equal(execWord('/opt/node 22/bin/node'), '"/opt/node 22/bin/node"');
  assert.equal(execWord('50%'), '50%%');
  assert.equal(execWord('$HOME'), '$$HOME');
  assert.equal(execWord(''), '""');
  assert.equal(execWord('a"b\\c'), '"a\\"b\\\\c"');
  const words = ['/opt/node 22/bin/node', 'cli.js', 'serve', '50%', '$HOME', 'a"b\\c', ''];
  assert.deepEqual(execWords(words.map(execWord).join(' ')), words);
  assert.deepEqual(execWords('/usr/bin/node /x/cli.js start --port 7233'), ['/usr/bin/node', '/x/cli.js', 'start', '--port', '7233'], 'an older, unquoted unit');
});

test('the unit: Restart=always, one appended log, PATH and env, every ExecStart word quoted', () => {
  const home = tempDir();
  const text = renderUnit(ID, spec(home, { env: { TOOL_X: '1' } }));
  assert.match(text, /^# Generated by Tool: `tool service install` rewrites this file\.$/m);
  assert.match(text, /^Description=Tool, as a service\nDocumentation=https:\/\/tool\.example\n\n\[Service\]$/m);
  assert.match(text, /^ExecStart="\/opt\/node 22\/bin\/node" \/usr\/lib\/node_modules\/tool\/dist\/cli\.js serve --port 7000 --home \/srv\/50%%\/\$\$HOME$/m);
  assert.match(text, /^Environment="PATH=\/opt\/node 22\/bin:\/usr\/bin"\nEnvironment="TOOL_X=1"$/m);
  assert.equal(unitKeepsAlive(text), true);
  assert.equal(unitKeepsAlive(text.replace('Restart=always', 'Restart=on-failure')), false);
  assert.equal(parseUnitLogPath(text), serviceLogPath(home));
  assert.match(text, /^StandardError=append:/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.deepEqual(parseUnitArgv(text), ['/opt/node 22/bin/node', '/usr/lib/node_modules/tool/dist/cli.js', 'serve', '--port', '7000', '--home', '/srv/50%/$HOME']);
  const { documentation: _, ...noDocs } = ID;
  assert.match(renderUnit(noDocs, spec(home)), /^Description=Tool, as a service\n\n\[Service\]$/m);
});

test('the unit path honours XDG_CONFIG_HOME, but a home passed in beats the ambient variable', () => {
  assert.equal(unitPath(ID, '/h', '/x'), path.join('/x', 'systemd', 'user', 'tool.service'));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/ambient';
  try {
    assert.equal(unitPath(ID, '/h'), path.join('/h', '.config', 'systemd', 'user', 'tool.service'));
    assert.equal(unitPath(ID), path.join('/ambient', 'systemd', 'user', 'tool.service'));
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});

function fakeSystemd(o: { active?: boolean; linger?: string; enableFails?: boolean } = {}) {
  let active = o.active ?? false;
  const f = fake((cmd, args) => {
    if (cmd === 'loginctl') return { stdout: o.linger ?? '' };
    const verb = args[1];
    if (verb === 'enable' && o.enableFails) return { status: 1, stderr: 'Failed to enable unit: Unit file tool.service does not exist.' };
    if (verb === 'is-active') return { status: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n' };
    if (verb === 'show') return { stdout: active ? '4242\n' : '0\n' };
    if (verb === 'enable' || verb === 'start' || verb === 'restart') active = true;
    if (verb === 'stop' || verb === 'disable') active = false;
    return {};
  });
  const home = tempDir();
  return { ...f, m: createSystemd(ID, { run: f.run, homeDir: home, user: 'ed' }), home };
}

test('systemd install: reload, enable --now; and a restart only when it was already active (C2 bug 1)', () => {
  const s = fakeSystemd();
  s.m.install(spec(s.home));
  assert.deepEqual(s.calls, ['systemctl --user daemon-reload', 'systemctl --user enable --now tool.service']);
  assert.ok(fs.existsSync(path.join(s.home, 'logs')), "the log's folder: systemd makes the file, not the folder");

  s.calls.length = 0;
  s.m.install(spec(s.home, { args: ['serve', '--port', '7001'] }));
  assert.deepEqual(s.calls, [
    'systemctl --user is-active tool.service',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now tool.service',
    'systemctl --user restart tool.service',
  ], '`enable --now` leaves an active unit running the old process');
  const st = s.m.status();
  assert.deepEqual([st.registered, st.running, st.pid, st.argv], [true, true, '4242', ['serve', '--port', '7001']]);
});

test('a first install systemd refuses leaves no unit behind; a refused reinstall keeps the unit it had', () => {
  const s = fakeSystemd({ enableFails: true });
  assert.throws(() => s.m.install(spec(s.home)), /systemctl --user enable --now tool.service failed \(exit 1\)/);
  assert.equal(fs.existsSync(s.m.unitPath), false, 'status would otherwise say it is installed');
  assert.equal(s.m.status().registered, false);
  assert.deepEqual(s.calls.slice(-2), ['systemctl --user disable tool.service', 'systemctl --user daemon-reload']);

  const again = fakeSystemd();
  again.m.install(spec(again.home));
  const refusing = createSystemd(ID, { run: fakeSystemd({ enableFails: true }).run, homeDir: again.home, user: 'ed' });
  assert.throws(() => refusing.install(spec(again.home)), /exit 1/);
  assert.ok(fs.existsSync(refusing.unitPath), 'a reinstall keeps its unit');
});

test('systemd start clears a failed state; stop and restart are the verbs; none of them disables', () => {
  const s = fakeSystemd();
  s.m.install(spec(s.home));
  s.calls.length = 0;
  s.m.stop();
  s.m.start();
  s.m.restart();
  assert.deepEqual(s.calls, [
    'systemctl --user stop tool.service',
    'systemctl --user reset-failed tool.service',
    'systemctl --user start tool.service',
    'systemctl --user daemon-reload',
    'systemctl --user reset-failed tool.service',
    'systemctl --user restart tool.service',
  ]);
  assert.ok(!s.calls.some((c) => c.includes('disable')));
});

test('systemd uninstall disables, removes the unit and reloads', () => {
  const s = fakeSystemd();
  assert.equal(s.m.uninstall(), false);
  s.m.install(spec(s.home));
  s.calls.length = 0;
  assert.equal(s.m.uninstall(), true);
  assert.deepEqual(s.calls, ['systemctl --user disable --now tool.service', 'systemctl --user daemon-reload']);
  assert.equal(fs.existsSync(s.m.unitPath), false);
});

test("systemctl's failures, in words a person can act on", () => {
  assert.match(systemctlFailure(ID, ['--user', 'start'], { status: null, stdout: '', stderr: '' }), /systemctl isn't available, so Tool can't install a service here.*Run `tool serve`/);
  assert.match(systemctlFailure(ID, ['--user', 'start'], { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' }), /can't reach systemd's per-user instance/);
  assert.equal(systemctlFailure(ID, ['--user', 'start', 'x'], { status: 5, stdout: '', stderr: 'Unit x not found.\n' }), 'systemctl --user start x failed (exit 5): Unit x not found.');
  const s = fake(() => ({ status: 1, stderr: 'Job failed' }));
  assert.throws(() => createSystemd(ID, { run: s.run, homeDir: tempDir() }).start(), /systemctl --user start tool\.service failed \(exit 1\): Job failed/);
});

test("linger: on, off, or unknown, and the advice only when it's off", () => {
  assert.deepEqual(fakeSystemd({ linger: 'Linger=yes\n' }).m.linger(), { applies: true, user: 'ed', enabled: true });
  const off = fakeSystemd({ linger: 'Linger=no\n' }).m.linger();
  assert.deepEqual(off, { applies: true, user: 'ed', enabled: false });
  const unknown = fakeSystemd({ linger: 'Could not get properties' }).m.linger();
  assert.deepEqual(unknown, { applies: true, user: 'ed' });
  assert.match(lingerAdvice(off, 'Tool')!, /^Linger is off, so the service stops when you log out, SSH sessions included\. To keep Tool running, once:\n {4}sudo loginctl enable-linger ed$/);
  assert.equal(lingerAdvice(unknown, 'Tool'), undefined);
  assert.equal(lingerAdvice({ applies: true, enabled: true }, 'Tool'), undefined);
  assert.equal(lingerAdvice({ applies: false }, 'Tool'), undefined);
});

// ---- the OS's manager

test('launchd on macOS, systemd on Linux, and a clear refusal anywhere else', () => {
  assert.equal(serviceManagerFor(ID, { platform: 'darwin', homeDir: '/h' }).kind, 'a launchd LaunchAgent');
  assert.equal(serviceManagerFor(ID, { platform: 'linux', homeDir: '/h' }).kind, 'a systemd --user service');
  assert.throws(
    () => serviceManagerFor(ID, { platform: 'win32' }),
    (err: Error) => err instanceof UnsupportedPlatformError && /runs on macOS \(launchd\) and Linux \(systemd --user\), not win32 yet/.test(err.message),
  );
});

// ---- logs

test('logs: the last lines, a window that starts mid-line, and following through a rotation', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'service.log');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  assert.equal(tailFile(file, 2), 'two\nthree');
  assert.equal(tailFile(file, 50), 'one\ntwo\nthree');
  fs.writeFileSync(file, `${'x'.repeat(300 * 1024)}\nlast\n`);
  assert.equal(tailFile(file, 5), 'last', 'the partial first line of the window is dropped');
  fs.writeFileSync(file, '');
  assert.equal(tailFile(file, 5), '');
  assert.equal(sizeOf(path.join(dir, 'none')), 0);

  fs.writeFileSync(file, 'before\n');
  const got: string[] = [];
  let ticks = 0;
  const follow = followFile(file, {
    from: sizeOf(file),
    intervalMs: 5,
    write: (s) => void got.push(s),
    keepGoing: () => {
      ticks++;
      if (ticks === 2) fs.appendFileSync(file, 'new\n');
      if (ticks === 4) fs.writeFileSync(file, 'rotated\n');
      return ticks < 7;
    },
  });
  await follow;
  assert.deepEqual(got, ['new\n', 'rotated\n']);
});
