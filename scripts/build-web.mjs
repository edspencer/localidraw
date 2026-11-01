// Bundles the page (web/) into dist/web: app-<hash>.js and app-<hash>.css, index.html (pointing at them), the favicon,
// and Excalidraw's fonts, so the installed package needs no network and no bundler. Everything esbuild writes has a
// hash in its name, so the server can tell browsers to keep it for good (isHashed in server/static.ts).
//
// With --watch (`npm run dev`), it builds React's and Excalidraw's development versions, unminified with source maps,
// and builds again on every change under web/. Each build writes a new index.html, which the page notices and reloads.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, watch as watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/web");
const watch = process.argv.includes("--watch");
const mode = watch ? "development" : "production";

/**
 * In development only: reloads the page when index.html changes, which is when a build finished. It asks for the
 * page's headers each second (a HEAD of /, so a few hundred bytes) and compares the ETag. A server that's restarting
 * just doesn't answer for a moment.
 */
const RELOAD = `<script>
      (() => {
        let seen;
        setInterval(async () => {
          const tag = await fetch("/", { method: "HEAD", cache: "no-store" }).then((r) => r.ok && r.headers.get("etag"), () => null);
          if (!tag) return;
          if (seen && tag !== seen) location.reload();
          seen = tag;
        }, 1000);
      })();
    </script>`;

const url = (output) => `/static/${output.slice("dist/web/".length)}`;

/** index.html, pointing at this build's script and stylesheet. */
function writeIndex(metafile) {
  const [entry, { cssBundle }] = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint === "web/main.tsx");
  let html = readFileSync(join(root, "web/index.html"), "utf8")
    .replace('"/static/app.js"', `"${url(entry)}"`)
    .replace('"/static/app.css"', `"${url(cssBundle)}"`);
  if (!html.includes(url(entry)) || !html.includes(url(cssBundle))) throw new Error("web/index.html doesn't load /static/app.js and /static/app.css");
  if (watch) html = html.replace("</body>", `  ${RELOAD}\n  </body>`);
  writeFileSync(join(out, "index.html"), html);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "web/favicon.svg"), join(out, "favicon.svg"));
cpSync(join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"), join(out, "assets/fonts"), { recursive: true });

const options = {
  entryPoints: { app: join(root, "web/main.tsx") },
  bundle: true,
  format: "esm",
  outdir: out,
  minify: !watch,
  sourcemap: watch ? "linked" : false,
  splitting: true,
  entryNames: "[name]-[hash]",
  chunkNames: "chunks/[name]-[hash]",
  metafile: true,
  absWorkingDir: root, // so the metafile's paths are relative to the checkout
  conditions: [mode],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": `"${mode}"`, "process.env.IS_PREACT": '"false"' },
  loader: { ".woff2": "file", ".ttf": "file" },
  publicPath: "/static/",
  logLevel: "warning",
};

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{
      name: "index-html",
      setup(b) {
        b.onEnd((result) => {
          if (result.errors.length) return; // esbuild has printed them; the page keeps the last good build
          writeIndex(result.metafile);
          console.log(`built dist/web (${new Date().toLocaleTimeString()})`);
        });
      },
    }],
  });
  await ctx.watch();
  // web/index.html and web/favicon.svg aren't imported, so esbuild doesn't watch them: a change to either rebuilds.
  for (const f of ["index.html", "favicon.svg"]) {
    watchFile(join(root, "web", f), () => {
      cpSync(join(root, "web/favicon.svg"), join(out, "favicon.svg"));
      void ctx.rebuild().catch(() => {});
    });
  }
} else {
  const { metafile } = await build(options);
  writeIndex(metafile);
  console.log("built dist/web");
}
