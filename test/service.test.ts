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

test("each flag belongs to its commands: anything else is a usage error", () => {
  for (const args of [[], ["frob"], ["--json"], ["status", "--force"], ["start", "--force"], ["logs", "--json"], ["install", "--json"], ["stop", "x"],
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
