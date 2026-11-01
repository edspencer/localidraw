// The package Localidraw runs from: its root folder, its version, and the built page.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// From source (server/) and installed (dist/server/) alike, the package root is the nearest folder with package.json.
export const pkgRoot = [resolve(here, ".."), resolve(here, "../..")].find((d) => existsSync(resolve(d, "package.json")))!;
export const pkg: { version: string } = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
export const webDir = resolve(pkgRoot, "dist/web");
