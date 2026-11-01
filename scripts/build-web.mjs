// Bundles the page (web/) into dist/web: app.js and app.css, index.html, the favicon, and Excalidraw's fonts, so
// the installed package needs no network and no bundler.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/web");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { app: join(root, "web/main.tsx") },
  bundle: true,
  format: "esm",
  outdir: out,
  minify: true,
  sourcemap: false,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  conditions: ["production"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  loader: { ".woff2": "file", ".ttf": "file" },
  publicPath: "/static/",
  logLevel: "warning",
});
cpSync(join(root, "web/index.html"), join(out, "index.html"));
cpSync(join(root, "web/favicon.svg"), join(out, "favicon.svg"));
cpSync(join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"), join(out, "assets/fonts"), { recursive: true });
console.log("built dist/web");
