// Hosted: the page reached by a name other than localhost (--allowed-host), as through a reverse proxy. Chromium maps
// the test names to 127.0.0.1, so the browser sends them as the Host and in the Origin, as it would for a real one.
import { startServer } from "../server/server.ts";
import { drawRectangle, expect, fromSkeletons, onScreen, saves, test as base, waitForCanvas } from "./fixtures.ts";

// `served`: each request the server answered, as [path, status], to see what a reload really fetched.
const test = base.extend<{ served: [string, number][] }>({
  served: async ({}, use) => use([]),
  baseURL: async ({ folder, served }, use) => {
    const app = await startServer({ root: folder.root, port: 0, webDir: `${import.meta.dirname}/../dist/web`, allowedHosts: ["draw.test"] });
    app.server.on("request", (req, res) => res.on("finish", () => served.push([new URL(req.url!, "http://x").pathname, res.statusCode])));
    await use(`http://draw.test:${new URL(app.url).port}/`);
    await app.close();
  },
});
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP draw.test 127.0.0.1, MAP other.test 127.0.0.1"] } });

test("through an allowed host name, it saves, and an edit on disk arrives over the events", async ({ page, folder, open }) => {
  const writes: number[] = [];
  page.on("response", (r) => { if (r.request().method() !== "GET") writes.push(r.status()); });
  await open("notes.excalidraw");
  expect(new URL(page.url()).hostname).toBe("draw.test");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).written).toBe(1);
  expect(writes).toEqual([200]);

  const scene = folder.scene("notes.excalidraw");
  const added = await fromSkeletons(page, [{ type: "ellipse", x: 400, y: 0, width: 100, height: 100 }]);
  folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });
  await expect.poll(async () => (await onScreen(page)).map((e) => e.id)).toContain(added[0].id);
});

test("the page's files are cached: hashed ones for good, the page itself revalidated", async ({ page, open, served }) => {
  const seen = new Map<string, { status: number; cache?: string; encoding?: string }>();
  page.on("response", async (r) => {
    const path = new URL(r.url()).pathname;
    seen.set(path, { status: r.status(), cache: (await r.allHeaders())["cache-control"], encoding: (await r.allHeaders())["content-encoding"] });
  });
  await open("notes.excalidraw");
  const script = [...seen.keys()].find((p) => /^\/static\/app-\w+\.js$/.test(p))!;
  expect(seen.get(script)).toMatchObject({ status: 200, cache: "public, max-age=31536000, immutable" });
  expect(seen.get(script)?.encoding).toMatch(/^(br|gzip)$/); // Chromium only offers brotli over https
  expect(seen.get("/")).toMatchObject({ status: 200, cache: "no-cache" });

  served.length = 0;
  await page.reload();
  await waitForCanvas(page, "notes.excalidraw");
  const statics = served.filter(([p]) => p === "/" || p.startsWith("/static/"));
  expect(statics).toContainEqual(["/", 304]); // revalidated, not downloaded again
  expect(statics.filter(([, status]) => status !== 304)).toEqual([]); // the hashed files didn't even ask
  expect(statics.some(([p]) => p === script)).toBe(false);
});

test("another name for the same address is refused", async ({ page, baseURL }) => {
  const other = baseURL!.replace("draw.test", "other.test");
  const res = await page.goto(other);
  expect(res?.status()).toBe(403);
  await expect(page.locator("body")).toContainText("--allowed-host");
});
