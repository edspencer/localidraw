// Bundles the page (web/) into dist/web: app-<hash>.js and app-<hash>.css, index.html (pointing at them), the favicon,
// and Excalidraw's fonts, so the installed package needs no network and no bundler. Everything esbuild writes has a
// hash in its name, so the server can tell browsers to keep it for good (isHashed in server/static.ts).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/web");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { metafile } = await build({
  entryPoints: { app: join(root, "web/main.tsx") },
  bundle: true,
  format: "esm",
  outdir: out,
  minify: true,
  sourcemap: false,
  splitting: true,
  entryNames: "[name]-[hash]",
  chunkNames: "chunks/[name]-[hash]",
  metafile: true,
  absWorkingDir: root, // so the metafile's paths are relative to the checkout
  conditions: ["production"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  loader: { ".woff2": "file", ".ttf": "file" },
  publicPath: "/static/",
  logLevel: "warning",
});
const [entry, { cssBundle }] = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint === "web/main.tsx");
const url = (output) => `/static/${output.slice("dist/web/".length)}`;
const html = readFileSync(join(root, "web/index.html"), "utf8")
  .replace('"/static/app.js"', `"${url(entry)}"`)
  .replace('"/static/app.css"', `"${url(cssBundle)}"`);
if (!html.includes(url(entry)) || !html.includes(url(cssBundle))) throw new Error("web/index.html doesn't load /static/app.js and /static/app.css");
writeFileSync(join(out, "index.html"), html);
cpSync(join(root, "web/favicon.svg"), join(out, "favicon.svg"));
cpSync(join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"), join(out, "assets/fonts"), { recursive: true });
console.log("built dist/web");
