// Restarting Localidraw while a drawing is being saved: a service restart, an `update`, `docker stop`. The page that's
// open must save what was drawn once the server is back, by itself, so nothing is lost. These run the real CLI and
// stop it with SIGTERM, as a service manager does, rather than closing a server in this process.
//
// That's why an open page isn't something `localidraw busy` counts (SPEC §4): only a save the server is writing is.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { drawRectangle, expect, saves, test, waitForCanvas } from "./fixtures.ts";

const CLI = join(import.meta.dirname, "../server/cli.ts");

type Serving = { child: ChildProcess; port: number; exited: Promise<number | null>; stderr: () => string };

/** `localidraw serve <root> --port <port>`, with its own HOME (for runtime.json); resolves once it prints its banner. */
function serve(root: string, home: string, port = 0): Promise<Serving> {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, "serve", root, "--port", String(port)], {
    env: cliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  return new Promise((ok, fail) => {
    let out = "", err = "";
    child.stderr!.on("data", (c) => { err += c; });
    child.stdout!.on("data", (c) => {
      out += c;
      const m = /^Localidraw \S+: http:\/\/localhost:(\d+)\//.exec(out);
      if (m) ok({ child, port: Number(m[1]), exited, stderr: () => err });
    });
    void exited.then((code) => fail(new Error(`localidraw exited ${code} before it was serving:\n${out}${err}`)));
  });
}

const cliEnv = () => ({ ...process.env, HOME: home, USERPROFILE: home, PORT: "", LOCALIDRAW_HOST: "", LOCALIDRAW_ALLOWED_HOSTS: "", LOCALIDRAW_POLL: "" });

/** Runs another `localidraw` command against the same HOME. */
const runCli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { env: cliEnv(), encoding: "utf8" });

/** What the server's /api/busy says it's counting. */
const busyCounts = async (s: Serving) => (await (await fetch(`http://localhost:${s.port}/api/busy`)).json()).counts;

/** SIGTERM, as systemd, launchd and `docker stop` send it, and waits for it to exit. */
async function terminate(s: Serving) {
  s.child.kill("SIGTERM");
  expect(await s.exited).toBe(0);
}

const rectangles = (folder: { elements: (p: string) => { type: string }[] }) =>
  folder.elements("notes.excalidraw").filter((e) => e.type === "rectangle").length;

let home: string;
let running: Serving[] = [];
test.beforeEach(() => { home = mkdtempSync(join(tmpdir(), "localidraw-home-")); });
test.afterEach(() => {
  for (const s of running) s.child.kill("SIGKILL");
  running = [];
  rmSync(home, { recursive: true, force: true });
});

async function openOn(page: Page, s: Serving) {
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events");
  await page.goto(`http://localhost:${s.port}/?canvas=notes.excalidraw`);
  await events;
  await waitForCanvas(page, "notes.excalidraw");
}

// The fixture's notes.excalidraw has one rectangle; each test draws a second.
test.skip(process.platform === "win32", "SIGTERM is POSIX; Windows stops it another way (SPEC §7)");

test("a save that's due when the server stops is written once it's back", async ({ page, folder }) => {
  const first = await serve(folder.root, home);
  running.push(first);
  await openOn(page, first);
  expect(rectangles(folder)).toBe(1);

  await drawRectangle(page);
  expect((await saves(page)).state).toBe("due"); // 700 ms to go
  await terminate(first);
  // The save comes due while nothing is listening: the page keeps the drawing and says so.
  await expect(page.locator(".ld-status")).toHaveText(/^Not saved/);
  expect(rectangles(folder)).toBe(1);

  const second = await serve(folder.root, home, first.port);
  running.push(second);
  // Nothing is touched on the page: it reconnects and saves by itself.
  await expect.poll(() => rectangles(folder), { timeout: 15_000 }).toBe(2);
  await expect(page.locator(".ld-status")).toHaveText(/^Saved/);
  await terminate(second);
});

test("a save on its way when the server stops is written once it's back", async ({ page, folder }) => {
  const first = await serve(folder.root, home);
  running.push(first);
  await openOn(page, first);

  // Hold the save between the page and the server, stop the server, then let the save go on to a server that's gone.
  let held: (r: Route) => void;
  const caught = new Promise<Route>((r) => { held = r; });
  let holding = true;
  await page.route("**/api/canvas?*", (route) => {
    if (holding && route.request().method() === "PUT") { holding = false; held(route); } else void route.continue();
  });
  await drawRectangle(page);
  const route = await caught;
  expect((await saves(page)).state).toBe("saving");
  await terminate(first);
  await route.continue().catch(() => {});
  await expect(page.locator(".ld-status")).toHaveText(/^Not saved/);
  expect(rectangles(folder)).toBe(1);

  const second = await serve(folder.root, home, first.port);
  running.push(second);
  await expect.poll(() => rectangles(folder), { timeout: 15_000 }).toBe(2);
  await expect(page.locator(".ld-status")).toHaveText(/^Saved/);
  await terminate(second);
});

test("a save the server is writing when it's stopped finishes before it exits", async ({ page, folder }) => {
  const first = await serve(folder.root, home);
  running.push(first);
  await openOn(page, first);

  // The save has reached the server, but its body hasn't all arrived: SIGTERM waits for it (cli.ts's drain).
  let release: () => void;
  const released = new Promise<void>((r) => { release = r; });
  await page.route("**/api/canvas?*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    // Forward it ourselves, sending the head at once and the body later, so the server is mid-request on SIGTERM.
    const req = route.request();
    const body = req.postDataBuffer()!;
    const upstream = request(req.url(), { method: "PUT", headers: { ...req.headers(), "content-length": String(body.length) } });
    upstream.flushHeaders();
    upstream.write(body.subarray(0, 1));
    await released;
    upstream.end(body.subarray(1));
    const res = await new Promise<IncomingMessage>((ok) => upstream.once("response", ok));
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    await route.fulfill({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: Buffer.concat(chunks) });
  });
  await drawRectangle(page);
  // The server counts it as a save under way, and so does `localidraw busy`, which finds it through runtime.json.
  await expect.poll(() => busyCounts(first)).toEqual({ canvas: 1, library: 0 });
  const busy = runCli(["busy"]);
  expect(busy.status).toBe(75);
  expect(busy.stdout).toBe("Localidraw is busy: 1 canvas save is running.\n");
  first.child.kill("SIGTERM");
  await expect.poll(() => first.stderr()).toMatch(/Stopping: waiting for 1 request/);
  expect(first.child.exitCode).toBe(null); // draining, waiting for this save
  release!();
  expect(await first.exited).toBe(0);
  expect(rectangles(folder)).toBe(2);
  await expect(page.locator(".ld-status")).toHaveText(/^Saved/);
});
