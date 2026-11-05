// `localidraw service …` (server/service.ts) against fake service managers, on any OS: what it writes, what it asks
// systemctl and launchctl to do, its exit codes, and what it refuses. The real managers are scripts/service-real.mjs's,
// in CI.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../server/contract/output.ts";
import type { Runner } from "../server/contract/service/manager.ts";
import { parseUnitArgv } from "../server/contract/service/systemd.ts";
import { pkg } from "../server/package.ts";
import { localFetch, parseServiceArgs, probeUrlFor, runService, serveArgs, settingsOf, urlFor, type ServiceContext } from "../server/service.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "localidraw-service-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A made-up machine: a home, a folder of canvases, and an installed package at `version`. */
function machine(opts: { pkgPath?: string[]; version?: string } = {}) {
  const root = join(tmp, String(++n));
  const homeDir = join(root, "home");
  const folder = join(root, "canvases");
  const pkgRoot = join(root, ...(opts.pkgPath ?? ["prefix", "lib", "node_modules", "localidraw"]));
  for (const d of [homeDir, folder, join(pkgRoot, "dist", "server"), join(pkgRoot, "dist", "web")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "localidraw", version: opts.version ?? "1.2.3" }));
  writeFileSync(join(pkgRoot, "dist", "server", "cli.js"), "");
  writeFileSync(join(pkgRoot, "dist", "web", "index.html"), "");
  return { root, homeDir, folder, pkgRoot };
}

/** A fake systemctl and loginctl: one unit, active or not. Every call is recorded. */
function fakeSystemd() {
  const calls: string[] = [];
  let active = false;
  const run: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (cmd === "loginctl") return ok("Linger=yes\n");
    const verb = args[1];
    if (verb === "is-active") return { status: active ? 0 : 3, stdout: active ? "active\n" : "inactive\n", stderr: "" };
    if (verb === "show") return ok(active ? "4242\n" : "0\n");
    if (verb === "enable" || verb === "start" || verb === "restart") active = true;
    if (verb === "stop" || verb === "disable") active = false;
    return ok();
  };
  return { run, calls, set active(v: boolean) { active = v; } };
}

/** A fake launchctl: `print` fails when nothing is loaded, as the real one does (or every install sits out a poll). */
function fakeLaunchd() {
  const calls: string[] = [];
  let loaded = false;
  const run: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const verb = args[0];
    if (verb === "print") return loaded ? { status: 0, stdout: "state = running\npid = 777\n", stderr: "" } : { status: 113, stdout: "", stderr: "Could not find service" };
    if (verb === "bootout") { const was = loaded; loaded = false; return was ? { status: 0, stdout: "", stderr: "" } : { status: 3, stdout: "", stderr: "No such process" }; }
    if (verb === "bootstrap") loaded = true;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

/** Runs `localidraw service <args>` and returns the exit code and what it printed. */
async function service(args: string[], ctx: Partial<ServiceContext> & { homeDir: string; pkgRoot: string }) {
  let stdout = "", stderr = "";
  const code = await runService(args, {
    platform: "linux",
    nodePath: process.execPath,
    pathEnv: "/usr/bin:/bin",
    waitReady: async () => "ready",
    probe: async () => undefined,
    portTaken: async () => false,
    fetch: (async () => { throw new Error("connection refused"); }) as typeof fetch, // nothing answers /api/busy
    sleep: () => {},
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    ...ctx,
  });
  return { code, stdout, stderr };
}

const unitFile = (homeDir: string) => join(homeDir, ".config", "systemd", "user", "localidraw.service");

test("status exits 4 with nothing installed, and --json is one document saying so", async () => {
  const m = machine();
  const sd = fakeSystemd();
  const r = await service(["status"], { ...m, run: sd.run });
  assert.equal(r.code, 4);
  assert.match(r.stdout, /isn't installed as a service/);
  const j = await service(["status", "--json"], { ...m, run: sd.run });
  assert.equal(j.code, 4);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.installed, false);
  assert.equal(doc.running, false);
  assert.equal(doc.unit, unitFile(m.homeDir));
  assert.equal(doc.home, join(m.homeDir, ".localidraw"));
  for (const k of ["installedVersion", "runningVersion", "port", "url", "pid", "log"]) assert.equal(doc[k], null, k);
  assert.deepEqual(doc.warnings, []);
  assert.equal("update" in doc, false, "left out, never null");
  assert.equal(j.stderr, "");
  assert.deepEqual(sd.calls.filter((c) => c.startsWith("systemctl")), [], "nothing to ask systemctl without a unit");
});

test("on Windows, status says not installed (4) and every other command says it isn't supported yet (1)", async () => {
  const m = machine();
  const s = await service(["status", "--json"], { ...m, platform: "win32" });
  assert.equal(s.code, 4);
  const doc = JSON.parse(s.stdout);
  assert.equal(doc.installed, false);
  assert.match(doc.warnings[0], /not win32 yet/);
  assert.match((await service(["status"], { ...m, platform: "win32" })).stdout, /isn't installed as a service: .*macOS \(launchd\) and Linux/);
  for (const args of [["install", m.folder], ["uninstall"], ["start"], ["stop"], ["restart"], ["logs"]]) {
    const r = await service(args, { ...m, platform: "win32" });
    assert.equal(r.code, 1, args[0]);
    assert.match(r.stderr, new RegExp(`^localidraw: \`localidraw service ${args[0]}\` runs on macOS \\(launchd\\) and Linux`), args[0]);
    assert.match(r.stderr, /A Windows service is planned/);
  }
});

test("install writes a unit that runs the installed CLI with serve, the folder and every setting, then waits for it", async () => {
  const m = machine();
  const sd = fakeSystemd();
  let waited = "";
  const r = await service(["install", m.folder, "--port", "4000"], { ...m, run: sd.run, waitReady: async (u) => { waited = u; return "ready"; } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /✓ Localidraw is installed as a user service, and running at http:\/\/localhost:4000\//);
  assert.equal(waited, "http://127.0.0.1:4000/");
  const unit = readFileSync(unitFile(m.homeDir), "utf8");
  const cli = join(m.pkgRoot, "dist", "server", "cli.js");
  assert.deepEqual(parseUnitArgv(unit).slice(1), [cli, "serve", m.folder, "--port", "4000", "--host", "127.0.0.1"]);
  assert.ok(unit.includes(`StandardOutput=append:${join(m.homeDir, ".localidraw", "logs", "service.log")}`), unit);
  assert.match(unit, /^Restart=always$/m);
  assert.ok(existsSync(join(m.homeDir, ".localidraw", "logs")), "the log's folder is made");
  assert.ok(sd.calls.includes("systemctl --user enable --now localidraw.service"));
  assert.ok(!sd.calls.includes("systemctl --user restart localidraw.service"), "a first install starts once");
});

test("status reads it all back from the unit, with the versions, and exits 0 only when it answers", async () => {
  const m = machine({ version: "1.2.3" });
  const sd = fakeSystemd();
  await service(["install", m.folder, "--host", "0.0.0.0", "--allowed-host", "draw.example", "--poll", "500"], { ...m, run: sd.run });
  const asked: string[] = [];
  const up = await service(["status", "--json"], { ...m, run: sd.run, probe: async (u) => { asked.push(u); return { ok: true, version: "1.2.3" }; } });
  assert.equal(up.code, 0);
  const doc = JSON.parse(up.stdout);
  assert.deepEqual(
    { installed: doc.installed, running: doc.running, answering: doc.answering, installedVersion: doc.installedVersion, runningVersion: doc.runningVersion, port: doc.port, url: doc.url, pid: doc.pid, folder: doc.folder, host: doc.host, allowedHosts: doc.allowedHosts, poll: doc.poll, linger: doc.linger, manager: doc.manager },
    { installed: true, running: true, answering: true, installedVersion: "1.2.3", runningVersion: "1.2.3", port: 3729, url: "http://localhost:3729/", pid: 4242, folder: m.folder, host: "0.0.0.0", allowedHosts: ["draw.example"], poll: 500, linger: true, manager: "systemd" },
  );
  assert.equal(doc.log, join(m.homeDir, ".localidraw", "logs", "service.log"));
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(asked, ["http://127.0.0.1:3729/"]);

  const prose = await service(["status"], { ...m, run: sd.run, probe: async () => ({ ok: true, version: "1.3.0" }) });
  assert.equal(prose.code, 0);
  assert.match(prose.stdout, /Version: 1\.3\.0 running, 1\.2\.3 installed/);
  assert.match(prose.stdout, /! It's running 1\.3\.0, but 1\.2\.3 is installed/);
  assert.match(prose.stdout, /answering to localhost, draw\.example/);

  assert.equal((await service(["status"], { ...m, run: sd.run, probe: async () => undefined })).code, 3, "running but not answering");
  sd.active = false;
  const down = await service(["status"], { ...m, run: sd.run });
  assert.equal(down.code, 3);
  assert.match(down.stdout, /isn't running/);
});

test("status warns when the Node, the CLI or the folder it names has gone", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await service(["install", m.folder], { ...m, run: sd.run });
  rmSync(m.folder, { recursive: true });
  rmSync(join(m.pkgRoot, "dist", "server", "cli.js"));
  const doc = JSON.parse((await service(["status", "--json"], { ...m, run: sd.run })).stdout);
  assert.ok(doc.warnings.some((w: string) => /cli\.js, which isn't there any more/.test(w)), JSON.stringify(doc.warnings));
  assert.ok(doc.warnings.some((w: string) => /The folder it serves, .*, isn't there any more/.test(w)), JSON.stringify(doc.warnings));
});

test("a reinstall keeps what the unit records unless told otherwise, and restarts a running service", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await service(["install", m.folder, "--port", "4001", "--host", "0.0.0.0", "--allowed-host", "a.example", "--poll"], { ...m, run: sd.run });
  sd.calls.length = 0;
  const r = await service(["install"], { ...m, run: sd.run }); // the folder comes from the unit too
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(settingsOf(serveArgsFromUnit(m.homeDir)), { folder: m.folder, port: 4001, host: "0.0.0.0", allowedHosts: ["a.example"], poll: 2000 });
  assert.ok(sd.calls.includes("systemctl --user restart localidraw.service"), "enable --now leaves an active unit alone, so it restarts it");

  const other = join(m.root, "other");
  mkdirSync(other);
  const moved = await service(["install", other, "--allowed-host", "b.example", "--port", "4002"], { ...m, run: sd.run });
  assert.match(moved.stdout, /one Localidraw service per machine: moving it from .*canvases to .*other/);
  assert.deepEqual(settingsOf(serveArgsFromUnit(m.homeDir)), { folder: other, port: 4002, host: "0.0.0.0", allowedHosts: ["b.example"], poll: 2000 });
});

/** The arguments after Node and the script, from the unit's ExecStart. */
function serveArgsFromUnit(homeDir: string): string[] {
  return parseUnitArgv(readFileSync(unitFile(homeDir), "utf8")).slice(2);
}

test("--refresh exits 4 with nothing installed, and otherwise re-writes the unit from itself, flags still winning", async () => {
  const m = machine();
  const sd = fakeSystemd();
  const none = await service(["install", "--refresh"], { ...m, run: sd.run });
  assert.equal(none.code, 4);
  assert.ok(!existsSync(unitFile(m.homeDir)), "no first install from defaults");
  await service(["install", m.folder, "--port", "4003"], { ...m, run: sd.run });
  const before = readFileSync(unitFile(m.homeDir), "utf8");
  const r = await service(["install", "--refresh"], { ...m, run: sd.run });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Re-writing .*localidraw\.service\n {2}Keeping: localidraw serve .* --port 4003 --host 127\.0\.0\.1/);
  assert.equal(readFileSync(unitFile(m.homeDir), "utf8"), before, "a faithful refresh is byte-identical");
  await service(["install", "--refresh", "--port", "4004"], { ...m, run: sd.run });
  assert.equal(settingsOf(serveArgsFromUnit(m.homeDir)).port, 4004);
});

test("install refuses npx's cache, a checkout without --from-checkout, an unbuilt package, and a folder in ~/.localidraw", async () => {
  const npx = machine({ pkgPath: ["npm-cache", "_npx", "abc123", "node_modules", "localidraw"] });
  const r1 = await service(["install", npx.folder], { ...npx, run: fakeSystemd().run });
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /npx's cache/);
  assert.ok(!existsSync(unitFile(npx.homeDir)));

  const checkout = machine({ pkgPath: ["src", "localidraw"] });
  const r2 = await service(["install", checkout.folder], { ...checkout, run: fakeSystemd().run });
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /is a checkout .* --from-checkout/s);
  assert.equal((await service(["install", checkout.folder, "--from-checkout"], { ...checkout, run: fakeSystemd().run })).code, 0);

  const unbuilt = machine();
  rmSync(join(unbuilt.pkgRoot, "dist", "web"), { recursive: true });
  const r3 = await service(["install", unbuilt.folder], { ...unbuilt, run: fakeSystemd().run });
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /isn't built/);

  const m = machine();
  const inside = join(m.homeDir, ".localidraw", "drawings");
  mkdirSync(inside, { recursive: true });
  await assert.rejects(service(["install", inside], { ...m, run: fakeSystemd().run }), /inside .*\.localidraw, Localidraw's own folder/);
  await assert.rejects(service(["install", join(m.root, "nope")], { ...m, run: fakeSystemd().run }), /isn't a folder/);
});

test("install keeps the hosting rule: a host beyond loopback needs an allowed host, at install as at serve", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await assert.rejects(service(["install", m.folder, "--host", "0.0.0.0"], { ...m, run: sd.run }), (e: Error) => e instanceof UsageError && /refusing to listen on 0\.0\.0\.0 without an allowed host/.test(e.message));
  await assert.rejects(service(["install", m.folder, "--host", "0.0.0.0", "--allowed-host", "http://x"], { ...m, run: sd.run }), /not a host name/);
  assert.ok(!existsSync(unitFile(m.homeDir)));
  const hosted = await service(["install", m.folder, "--host", "192.168.1.5", "--allowed-host", "draw.lan"], { ...m, run: sd.run });
  assert.equal(hosted.code, 0);
  assert.match(hosted.stdout, /has no login/);
  assert.match(hosted.stdout, /running at http:\/\/192\.168\.1\.5:3729\//);
});

test("install refuses a port something else holds, and says when it's another Localidraw", async () => {
  const m = machine();
  const sd = fakeSystemd();
  const other = await service(["install", m.folder], { ...m, run: sd.run, portTaken: async () => true });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /port 3729 is in use by something else/);
  const serve = await service(["install", m.folder], { ...m, run: sd.run, portTaken: async () => true, probe: async () => ({ ok: true, version: "0.5.0" }) });
  assert.match(serve.stderr, /in use by another Localidraw \(0\.5\.0\), probably a `localidraw serve`/);
  assert.ok(!existsSync(unitFile(m.homeDir)));
  // Its own port, held by itself, is fine: that's a reinstall.
  await service(["install", m.folder], { ...m, run: sd.run });
  assert.equal((await service(["install", m.folder], { ...m, run: sd.run, portTaken: async () => true })).code, 0);
  // But a move to a port something else holds is refused.
  assert.equal((await service(["install", m.folder, "--port", "4005"], { ...m, run: sd.run, portTaken: async () => true })).code, 1);
});

test("an install that never answers exits 1 and prints the end of the log", async () => {
  const m = machine();
  const sd = fakeSystemd();
  mkdirSync(join(m.homeDir, ".localidraw", "logs"), { recursive: true });
  writeFileSync(join(m.homeDir, ".localidraw", "logs", "service.log"), "first\nlocalidraw: port 3729 is in use\n");
  const r = await service(["install", m.folder], { ...m, run: sd.run, waitReady: async () => "timeout" });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /didn't answer at http:\/\/localhost:3729\/[^]*port 3729 is in use/);
});

test("a first install the manager refuses leaves no unit behind; a refused reinstall keeps the old one", async () => {
  const m = machine();
  const noSystemd: Runner = () => ({ status: null, stdout: "", stderr: "" });
  const r = await service(["install", m.folder], { ...m, run: noSystemd });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /systemctl isn't available/);
  assert.ok(!existsSync(unitFile(m.homeDir)), "no unit for a service that never existed");
  assert.equal((await service(["status"], { ...m, run: noSystemd })).code, 4);
  await service(["install", m.folder], { ...m, run: fakeSystemd().run });
  assert.equal((await service(["install", m.folder, "--port", "4010"], { ...m, run: noSystemd })).code, 1);
  assert.ok(existsSync(unitFile(m.homeDir)), "a reinstall that failed leaves a unit, which status and restart can see");
});

test("--dry-run prints the unit and writes nothing", async () => {
  const m = machine();
  const sd = fakeSystemd();
  const r = await service(["install", m.folder, "--dry-run"], { ...m, run: sd.run });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /not written: --dry-run[^]*ExecStart=.* serve /);
  assert.ok(!existsSync(unitFile(m.homeDir)));
  assert.deepEqual(sd.calls.filter((c) => c.startsWith("systemctl")), []);
  const mac = await service(["install", m.folder, "--dry-run"], { ...m, platform: "darwin", run: fakeLaunchd().run });
  assert.match(mac.stdout, /<string>net\.edspencer\.localidraw<\/string>[^]*<string>serve<\/string>/);
});

test("stop stops without disabling; start and restart wait for it; each exits 4 with nothing installed", async () => {
  const m = machine();
  const sd = fakeSystemd();
  for (const a of ["start", "stop", "restart", "logs"]) assert.equal((await service([a], { ...m, run: sd.run })).code, 4, a);
  await service(["install", m.folder], { ...m, run: sd.run });
  sd.calls.length = 0;
  const stopped = await service(["stop"], { ...m, run: sd.run });
  assert.equal(stopped.code, 0);
  assert.match(stopped.stdout, /stopped, and still installed/);
  assert.ok(sd.calls.includes("systemctl --user stop localidraw.service"));
  assert.ok(!sd.calls.some((c) => / disable /.test(c)), "stop never disables (SPEC §1)");
  assert.match((await service(["stop"], { ...m, run: sd.run })).stdout, /already stopped/);
  assert.equal((await service(["stop", "--force"], { ...m, run: sd.run })).code, 0, "--force is taken");

  const started = await service(["start"], { ...m, run: sd.run });
  assert.equal(started.code, 0);
  assert.match(started.stdout, /✓ Localidraw is running \(pid 4242\) at http:\/\/localhost:3729\//);
  assert.ok(sd.calls.includes("systemctl --user reset-failed localidraw.service"), "a failed unit is cleared first");
  assert.match((await service(["start"], { ...m, run: sd.run })).stdout, /already running/);
  sd.calls.length = 0;
  assert.equal((await service(["restart", "--force"], { ...m, run: sd.run })).code, 0);
  assert.ok(sd.calls.includes("systemctl --user restart localidraw.service"));
  sd.active = false;
  const late = await service(["start"], { ...m, run: sd.run, waitReady: async () => "timeout" });
  assert.equal(late.code, 1);
  assert.match(late.stdout, /didn't answer/);
});

/** A fake `/api/busy`, recording what it was asked. */
function busyAnswer(counts: Record<string, number>) {
  const asked: string[] = [];
  const fetch = (async (url: string | URL) => {
    asked.push(String(url));
    const busy = Object.values(counts).some((n) => n > 0);
    return new Response(JSON.stringify({ busy, version: "1.2.3", counts }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

test("stop and restart refuse with 75 while a save is being written, asking the unit's own port; --force goes ahead", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await service(["install", m.folder, "--port", "4006"], { ...m, run: sd.run });
  const busy = busyAnswer({ canvas: 1, library: 0 });
  for (const a of ["stop", "restart"]) {
    sd.calls.length = 0;
    const r = await service([a], { ...m, run: sd.run, fetch: busy.fetch });
    assert.equal(r.code, 75, a);
    assert.equal(r.stderr, "localidraw: Localidraw is busy: 1 canvas save is running. Try again in a moment, once it's written, or use --force.\n", a);
    assert.ok(!sd.calls.some((c) => / (stop|restart) /.test(c)), `${a} asked systemctl nothing that stops it: ${sd.calls.join("; ")}`);
  }
  assert.deepEqual(busy.asked, ["http://127.0.0.1:4006/api/busy", "http://127.0.0.1:4006/api/busy"]);

  const both = busyAnswer({ canvas: 2, library: 1 });
  const forced = await service(["restart", "--force"], { ...m, run: sd.run, fetch: both.fetch });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stderr, /^Overriding: Localidraw is busy: 2 canvas saves and 1 Library save are running\.\n/);
  assert.ok(sd.calls.includes("systemctl --user restart localidraw.service"));
  const stopped = await service(["stop", "--force"], { ...m, run: sd.run, fetch: busy.fetch });
  assert.equal(stopped.code, 0);
  assert.ok(sd.calls.includes("systemctl --user stop localidraw.service"));

  // Idle, or an older Localidraw with no /api/busy (404), goes ahead without a word.
  await service(["start"], { ...m, run: sd.run });
  const idle = await service(["stop"], { ...m, run: sd.run, fetch: busyAnswer({ canvas: 0, library: 0 }).fetch });
  assert.equal(idle.code, 0);
  assert.equal(idle.stderr, "");
  await service(["start"], { ...m, run: sd.run });
  const old = await service(["restart"], { ...m, run: sd.run, fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch });
  assert.equal(old.code, 0, old.stderr);
});

test("status repeats the last update check, in its JSON and on stderr, and never a check about another version", async () => {
  const m = machine();
  const sd = fakeSystemd();
  const home = join(m.homeDir, ".localidraw");
  mkdirSync(home, { recursive: true });
  const check = (current: string) => writeFileSync(join(home, "update-check.json"), JSON.stringify({
    name: "localidraw", current, target: "99.0.0", tag: "latest", updateAvailable: true, installMethod: "npm-global", canUpdate: true,
    command: "localidraw update", engines: ">=22", nodeOk: true, changelog: "https://github.com/edspencer/localidraw/releases/tag/v99.0.0", checkedAt: new Date().toISOString(),
  }));
  check(pkg.version);
  const j = await service(["status", "--json"], { ...m, run: sd.run });
  assert.equal(j.code, 4);
  assert.deepEqual(JSON.parse(j.stdout).update, { latest: "99.0.0", updateAvailable: true, checkedAt: JSON.parse(readFileSync(join(home, "update-check.json"), "utf8")).checkedAt });
  assert.match(j.stderr, new RegExp(`^Localidraw 99\\.0\\.0 is available \\(you have ${pkg.version.replace(/\./g, "\\.")}\\)\\.\n  Run: localidraw update\n  Changes: https://github\\.com/edspencer/localidraw/releases/tag/v99\\.0\\.0\n$`));
  await service(["install", m.folder], { ...m, run: sd.run });
  const prose = await service(["status"], { ...m, run: sd.run });
  assert.match(prose.stdout, /^Localidraw is running/);
  assert.match(prose.stderr, /Localidraw 99\.0\.0 is available/);

  check("0.0.1"); // written by another version: it says nothing about this one
  const other = await service(["status", "--json"], { ...m, run: sd.run });
  assert.equal("update" in JSON.parse(other.stdout), false);
  assert.equal(other.stderr, "");
});

test("restart re-writes a unit whose Node has gone", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await service(["install", m.folder, "--port", "4006"], { ...m, run: sd.run, nodePath: join(m.root, "old-node") });
  sd.calls.length = 0;
  const r = await service(["restart"], { ...m, run: sd.run });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Re-writing .* names a Node or a Localidraw that has gone/);
  const unit = readFileSync(unitFile(m.homeDir), "utf8");
  assert.ok(!unit.includes("old-node"), unit);
  assert.match(unit, /--port 4006/);
});

test("uninstall removes the unit, keeps the log, and is fine with nothing installed", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await service(["install", m.folder], { ...m, run: sd.run });
  const log = join(m.homeDir, ".localidraw", "logs", "service.log");
  writeFileSync(log, "kept\n");
  const r = await service(["uninstall"], { ...m, run: sd.run });
  assert.equal(r.code, 0);
  assert.ok(!existsSync(unitFile(m.homeDir)));
  assert.equal(readFileSync(log, "utf8"), "kept\n");
  assert.ok(existsSync(join(m.folder)), "the canvases are untouched");
  assert.match((await service(["uninstall"], { ...m, run: sd.run })).stdout, /Nothing to do/);
  assert.equal((await service(["status"], { ...m, run: sd.run })).code, 4);
});

test("logs prints the last lines of the file the unit names", async () => {
  const m = machine();
  const sd = fakeSystemd();
  await service(["install", m.folder], { ...m, run: sd.run });
  const empty = await service(["logs"], { ...m, run: sd.run });
  assert.equal(empty.code, 0);
  assert.match(empty.stderr, /nothing has been written to .*service\.log yet/);
  writeFileSync(join(m.homeDir, ".localidraw", "logs", "service.log"), Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const r = await service(["logs"], { ...m, run: sd.run });
  assert.equal(r.stdout.split("\n").filter(Boolean).length, 50);
  assert.match(r.stdout, /^line 30\n[^]*line 79\n$/);
  assert.equal((await service(["logs", "-n", "2"], { ...m, run: sd.run })).stdout, "line 78\nline 79\n");
});

test("on macOS it's a LaunchAgent: bootstrap to install and start, bootout to stop, the plist kept", async () => {
  const m = machine();
  const ld = fakeLaunchd();
  const ctx = { ...m, platform: "darwin" as const, run: ld.run };
  const plist = join(m.homeDir, "Library", "LaunchAgents", "net.edspencer.localidraw.plist");
  const r = await service(["install", m.folder], ctx);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /installed as a LaunchAgent/);
  const xml = readFileSync(plist, "utf8");
  assert.match(xml, new RegExp(`<string>serve</string>\\s*<string>${m.folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>\\s*<string>--port</string>\\s*<string>3729</string>`));
  const s = JSON.parse((await service(["status", "--json"], { ...ctx, probe: async () => ({ ok: true, version: "1.2.3" }) })).stdout);
  assert.equal(s.manager, "launchd");
  assert.equal(s.pid, 777);
  assert.equal(s.linger, null);
  ld.calls.length = 0;
  assert.equal((await service(["stop"], ctx)).code, 0);
  assert.ok(ld.calls.some((c) => c.startsWith("launchctl bootout gui/")));
  assert.ok(existsSync(plist), "stop keeps the plist, so the next login starts it");
  assert.equal((await service(["status"], ctx)).code, 3);
  assert.equal((await service(["start"], ctx)).code, 0);
  assert.ok(ld.calls.some((c) => c.startsWith("launchctl bootstrap gui/")));
});

test("--json on install, uninstall, start, stop and restart: one document on stdout, whatever happened, prose on stderr", async () => {
  const m = machine();
  const sd = fakeSystemd();
  const json = async (args: string[], extra: Partial<ServiceContext> = {}) => {
    const r = await service([...args, "--json"], { ...m, run: sd.run, ...extra });
    let doc;
    assert.doesNotThrow(() => (doc = JSON.parse(r.stdout)), `${args.join(" ")}: stdout is one JSON document: ${r.stdout}`);
    return { ...r, doc: doc as unknown as Record<string, any> };
  };
  // Nothing installed: start, stop and restart exit 4, and say so in the document too.
  for (const a of ["start", "stop", "restart"]) {
    const r = await json([a]);
    assert.equal(r.code, 4, a);
    assert.deepEqual([r.doc.ok, r.doc.action, r.doc.error, r.doc.installed], [false, a, "not installed", false], a);
    assert.match(r.stderr, /isn't installed as a service/, a);
  }
  const dry = await json(["install", m.folder, "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.deepEqual([dry.doc.ok, dry.doc.dryRun, dry.doc.installed], [true, true, false]);
  assert.match(dry.doc.rendered, /^\[Unit\][^]*ExecStart=.* serve /m);
  assert.doesNotMatch(dry.stderr, /ExecStart/, "the unit is in the document, not repeated on stderr");

  const inst = await json(["install", m.folder], { probe: async () => ({ ok: true, version: "1.2.3" }) });
  assert.equal(inst.code, 0, inst.stderr);
  assert.deepEqual([inst.doc.ok, inst.doc.action, "error" in inst.doc, inst.doc.installed, inst.doc.running, inst.doc.answering, inst.doc.folder, inst.doc.port],
    [true, "install", false, true, true, true, m.folder, 3729]);
  assert.match(inst.stderr, /✓ Localidraw is installed/);
  const other = join(m.root, "other");
  mkdirSync(other);
  assert.equal((await json(["install", other])).doc.movedFrom, m.folder);

  const stopped = await json(["stop"]);
  assert.deepEqual([stopped.code, stopped.doc.ok, stopped.doc.wasRunning, stopped.doc.running], [0, true, true, false]);
  assert.equal((await json(["stop"])).doc.wasRunning, false);
  const started = await json(["start"]);
  assert.deepEqual([started.code, started.doc.wasRunning, started.doc.running], [0, false, true]);
  const restarted = await json(["restart"]);
  assert.deepEqual([restarted.code, restarted.doc.action, restarted.doc.rewritten], [0, "restart", false]);

  // Busy: 75, refused, with error "busy".
  const busyFetch = (async () => new Response(JSON.stringify({ busy: true, version: "1.2.3", counts: { canvas: 1, library: 0 } }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  const busy = await json(["stop"], { fetch: busyFetch });
  assert.deepEqual([busy.code, busy.doc.ok, busy.doc.error, busy.doc.running], [75, false, "busy", true]);
  assert.match(busy.stderr, /Localidraw is busy: 1 canvas save is running/);

  // A start that doesn't answer: exit 1, and why.
  sd.active = false;
  const late = await json(["start"], { waitReady: async () => "timeout" });
  assert.equal(late.code, 1);
  assert.match(late.doc.error, /^it was started, but didn't answer at http:\/\/localhost:3729\//);

  // A refusal the manager or the checks throw: exit 1, the message as error.
  const checkout = machine({ pkgPath: ["src", "localidraw"] });
  const refusedInstall = await service(["install", checkout.folder, "--json"], { ...checkout, run: fakeSystemd().run });
  assert.equal(refusedInstall.code, 1);
  assert.match(JSON.parse(refusedInstall.stdout).error, /is a checkout/);
  assert.match(refusedInstall.stderr, /^localidraw: this Localidraw is a checkout/);

  const gone = await json(["uninstall"]);
  assert.deepEqual([gone.code, gone.doc.ok, gone.doc.wasInstalled, gone.doc.installed], [0, true, true, false]);
  assert.equal((await json(["uninstall"])).doc.wasInstalled, false);

  const win = await service(["stop", "--json"], { ...m, platform: "win32" });
  assert.equal(win.code, 1);
  assert.match(JSON.parse(win.stdout).error, /A Windows service is planned/);
});

test("each flag belongs to its commands: anything else is a usage error", () => {
  for (const args of [[], ["frob"], ["--json"], ["status", "--force"], ["start", "--force"], ["logs", "--json"], ["stop", "x"],
    ["install", "a", "b"], ["install", "--port", "x"], ["install", "--port", "0"], ["logs", "-n", "0"], ["status", "--json=1"], ["install", "--refresh", "--dry-run"], ["status", "--nope"]]) {
    assert.throws(() => parseServiceArgs(args), UsageError, JSON.stringify(args));
  }
  assert.equal(parseServiceArgs(["status", "--help"]), "help");
  assert.deepEqual(parseServiceArgs(["logs", "-f", "-n", "5"]), { action: "logs", refresh: false, dryRun: false, fromCheckout: false, force: false, json: false, follow: true, lines: 5 });
});

test("the unit's arguments read back as the settings they were written from", () => {
  const s = { folder: "/a b/c", port: 1234, host: "::1", allowedHosts: ["x.example", "y.example"], poll: 700 };
  assert.deepEqual(settingsOf(serveArgs(s)), s);
  assert.deepEqual(settingsOf(serveArgs({ folder: "/f", port: 1, host: "127.0.0.1", allowedHosts: [] })), { folder: "/f", port: 1, host: "127.0.0.1" });
  assert.equal(urlFor("0.0.0.0", 1), "http://localhost:1/");
  assert.equal(urlFor("10.0.0.2", 1), "http://10.0.0.2:1/");
  assert.equal(urlFor("fd00::2", 1), "http://[fd00::2]:1/");
  assert.equal(probeUrlFor("::", 1), "http://127.0.0.1:1/");
  assert.equal(probeUrlFor("[::1]", 1), "http://[::1]:1/");
  assert.equal(probeUrlFor("10.0.0.2", 1), "http://10.0.0.2:1/");
});

test("the health probe says Host: localhost, so a service bound to one LAN address isn't refused by its own guard", async () => {
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: req.headers.host })));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const { port } = server.address() as { port: number };
    const res = await localFetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { host: `localhost:${port}` });
  } finally {
    server.close();
  }
});
