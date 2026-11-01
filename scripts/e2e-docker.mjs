// Runs the browser tests, theme snapshots included, inside the official Playwright image, the one CI uses, so
// screenshots match the committed baselines byte for byte. Needs Docker.
//
//   npm run test:e2e:snapshots                       # compare
//   npm run test:e2e:snapshots -- --update-snapshots # remake the baselines in e2e/snapshots/
//
// Anything after `--` goes to `playwright test`. The checkout's files (git's list: tracked, plus new ones that
// aren't ignored) go in as a tar on stdin, and the baselines and test-results/ come back with `docker cp`, so the
// container's node_modules never replaces yours and it works with a remote Docker daemon too.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The image's browsers have to be the ones this @playwright/test drives, so the tag follows the pinned version.
const version = pkg.devDependencies["@playwright/test"];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`pin @playwright/test to an exact version (it's ${version})`);
const IMAGE = `mcr.microsoft.com/playwright:v${version}-noble`;

const args = process.argv.slice(2).map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
const script = `
set -e
mkdir /work && cd /work && tar -xf -
npm ci --no-audit --no-fund --loglevel=error
npm run build:web
npx playwright test ${args}
`;

const sh = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
};
const files = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
if (files.status !== 0) throw new Error("git ls-files failed");
const present = files.stdout.toString().split("\0").filter((f) => f && existsSync(join(root, f)));
const tar = spawnSync("tar", ["-cf", "-", "--null", "-T", "-"], { cwd: root, input: present.join("\0"), maxBuffer: 1 << 30 });
if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);

const name = `localidraw-e2e-${process.pid}`;
const status = sh("docker", ["run", "-i", "--name", name, "--ipc=host", "--init", "-e", "LOCALIDRAW_SNAPSHOTS=1", "-e", "CI",
  IMAGE, "bash", "-c", script], { input: tar.stdout, stdio: ["pipe", "inherit", "inherit"] });
mkdirSync(join(root, "e2e/snapshots"), { recursive: true });
rmSync(join(root, "test-results"), { recursive: true, force: true });
sh("docker", ["cp", `${name}:/work/e2e/snapshots/.`, "e2e/snapshots/"], { stdio: "ignore" });
sh("docker", ["cp", `${name}:/work/test-results`, "test-results"], { stdio: "ignore" });
sh("docker", ["rm", name], { stdio: "ignore" });
process.exit(status);
