// The default port is written out in the README, the help text and AGENTS.md. These tests keep them in step with
// DEFAULT_PORT in server/port.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "../server/port.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

test(`the README gives ${DEFAULT_PORT} as the default port, and every localhost URL uses it`, () => {
  const readme = read("README.md");
  assert.match(readme, new RegExp(`--port <n>\`: the port \\(default ${DEFAULT_PORT}\\b`));
  const ports = [...readme.matchAll(/localhost:(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(ports.length > 0, "the README has no localhost URL");
  assert.deepEqual(ports.filter((p) => p !== DEFAULT_PORT), []);
});

test(`--help gives ${DEFAULT_PORT} as the default port`, () => {
  const help = execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "server/cli.ts"), "--help"], { encoding: "utf8" });
  assert.match(help, new RegExp(`--port <n>\\s+the port \\(default ${DEFAULT_PORT}\\b`));
});

test(`AGENTS.md gives ${DEFAULT_PORT} as DEFAULT_PORT`, () => {
  assert.match(read("AGENTS.md"), new RegExp(`\`DEFAULT_PORT\` in \`server/port.ts\`: ${DEFAULT_PORT}\\b`));
});

test("the port spells DRAW on a phone keypad, as the docs say", () => {
  const keypad: Record<string, string> = { D: "3", R: "7", A: "2", W: "9" };
  assert.equal(Number([..."DRAW"].map((c) => keypad[c]).join("")), DEFAULT_PORT);
});
