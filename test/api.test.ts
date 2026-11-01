// The page's API client (web/api.ts), against a stand-in fetch: what it makes of the server's answers.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { getProjects, putCanvas } from "../web/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const answer = (body: string, init: ResponseInit) => { globalThis.fetch = async () => new Response(body, init); };

test("an error says why: the server's message, or else its status", async () => {
  answer(JSON.stringify({ error: "That isn't a path inside the folder." }), { status: 400 });
  await assert.rejects(getProjects(), { message: "That isn't a path inside the folder.", status: 400 } as object);
  // A reverse proxy's bare 502 while the server is down; over HTTP/2 there's no status text either.
  answer("", { status: 502 });
  await assert.rejects(putCanvas("a.excalidraw", "h", "{}"), { message: "The server answered 502.", status: 502 } as object);
});

test("a save says when the file moved on (409), or is gone (410)", async () => {
  answer(JSON.stringify({ hash: "new", scene: { elements: [] } }), { status: 409 });
  assert.deepEqual(await putCanvas("a.excalidraw", "old", "{}"), { ok: false, conflict: { hash: "new", scene: { elements: [] } } });
  answer(JSON.stringify({ error: "gone" }), { status: 410 });
  assert.deepEqual(await putCanvas("a.excalidraw", "old", "{}"), { ok: false, gone: true });
  answer(JSON.stringify({ hash: "saved" }), { status: 200 });
  assert.deepEqual(await putCanvas("a.excalidraw", "old", "{}"), { ok: true, hash: "saved" });
});
