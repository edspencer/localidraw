// `npm run dev [-- <folder> <options>]`: the page rebuilt on every change under web/ (build-web.mjs --watch), and the
// server run from source and restarted on every change under server/ (tsx watch). The page reloads itself after each
// build, and reconnects after each restart, as it does whenever the server comes back.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const children = [];
const stop = (code = 0) => { for (const c of children) c.kill(); process.exit(code); };
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

const web = spawn(process.execPath, [join(root, "scripts/build-web.mjs"), "--watch"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
children.push(web);
web.on("exit", (code) => stop(code ?? 1));
let started = false;
web.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  // The server won't start until the page is built, so wait for the first build.
  if (started || !String(chunk).includes("built dist/web")) return;
  started = true;
  const server = spawn(process.execPath, [tsx, "watch", "--clear-screen=false", join(root, "server/cli.ts"), ...process.argv.slice(2)], { cwd: process.cwd(), stdio: "inherit" });
  children.push(server);
  server.on("exit", (code) => stop(code ?? 1));
});
