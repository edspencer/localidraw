// The default port is written out in the README, the help text, AGENTS.md and the docs site. These tests keep them in
// step with DEFAULT_PORT in server/port.ts, and keep the docs site's sidebar in step with its pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

test("CI's Playwright image matches the pinned @playwright/test, so the snapshots' browsers are the ones it drives", () => {
  const version = JSON.parse(read("package.json")).devDependencies["@playwright/test"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "@playwright/test is pinned to an exact version");
  const images = [...read(".github/workflows/ci.yml").matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/g)].map((m) => m[1]);
  assert.ok(images.length > 0, "ci.yml runs the browser tests in the Playwright image");
  assert.deepEqual(images.filter((v) => v !== version), []);
});

// The docs site (website/) is built on its own, so it keeps a copy of the port in website/src/site.mjs.
const site = read("website/src/site.mjs");
const docsPages = (dir = "website/src/content/docs"): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? docsPages(`${dir}/${e.name}`) : /\.mdx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

test(`the docs site's DEFAULT_PORT is ${DEFAULT_PORT}, and every localhost URL in its pages uses it`, () => {
  assert.match(site, new RegExp(`export const DEFAULT_PORT = ${DEFAULT_PORT};`));
  const pages = docsPages();
  assert.ok(pages.length > 0, "no docs pages found");
  for (const page of pages) {
    const ports = [...read(page).matchAll(/localhost:(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(ports.filter((p) => p !== DEFAULT_PORT), [], page);
  }
});

test("package.json's homepage is the docs site", () => {
  const url = site.match(/export const SITE_URL = '([^']+)'/)?.[1];
  assert.ok(url, "website/src/site.mjs has no SITE_URL");
  assert.equal(JSON.parse(read("package.json")).homepage, url);
});

test("every docs page is in the sidebar, and every sidebar entry has a page", () => {
  const slugs = [...read("website/astro.config.mjs").matchAll(/slug: '([^']+)'/g)].map((m) => m[1]).sort();
  const pages = docsPages()
    .map((p) => p.replace(/^website\/src\/content\/docs\//, "").replace(/\.mdx?$/, ""))
    .filter((p) => p !== "index") // the home page, which isn't in the sidebar
    .sort();
  assert.deepEqual(slugs, pages);
});

test(`the Dockerfile and compose.yaml use ${DEFAULT_PORT}, publish it on loopback, and keep the image's refusal`, () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, new RegExp(`PORT=${DEFAULT_PORT}\\b`));
  assert.match(dockerfile, new RegExp(`^EXPOSE ${DEFAULT_PORT}$`, "m"));
  // It listens on every address, so the CLI's refusal without allowed hosts is what keeps it safe.
  assert.match(dockerfile, /LOCALIDRAW_HOST=0\.0\.0\.0/);
  const instructions = dockerfile.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(instructions, /LOCALIDRAW_ALLOWED_HOSTS/, "the image must not bake in an allowed host");
  const compose = read("compose.yaml");
  const ports = [...compose.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(ports, [`127.0.0.1:${DEFAULT_PORT}:${DEFAULT_PORT}`]);
});
