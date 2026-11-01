// The server's API, as the page uses it.
export type Canvas = { path: string; name: string };
export type Project = { dir: string; canvases: Canvas[] };
export type Scene = { elements: any[]; appState?: Record<string, unknown>; files?: Record<string, any> };
export type Loaded = { hash: string; scene: Scene };

const canvasUrl = (path: string) => `/api/canvas?path=${encodeURIComponent(path)}`;

async function reply<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status, body });
  return body as T;
}

export const getProjects = () => fetch("/api/projects").then((r) => reply<{ root: string; projects: Project[] }>(r));
export const getCanvas = (path: string) => fetch(canvasUrl(path)).then((r) => reply<Loaded>(r));
export const createCanvas = (path: string) =>
  fetch("/api/canvases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) })
    .then((r) => reply<{ path: string }>(r));

/** Saves over the version with `baseHash`. A 409 means the file moved on: its new version comes back to merge. */
export async function putCanvas(path: string, baseHash: string, content: string):
  Promise<{ ok: true; hash: string } | { ok: false; conflict: Loaded }> {
  const res = await fetch(canvasUrl(path), { method: "PUT", headers: { "x-base-hash": baseHash, "content-type": "application/json" }, body: content });
  if (res.status === 409) return { ok: false, conflict: await res.json() };
  return { ok: true, ...(await reply<{ hash: string }>(res)) };
}

export type LibraryFile = { libraryItems?: any[]; library?: any[] };
/** The folder's Library file, if it has one (`shared`), with its hash. */
export const getLibrary = () => fetch("/api/library").then((r) => reply<{ shared: false } | { shared: true; hash: string; library: LibraryFile }>(r));

/** Saves the Library file over the version with `baseHash`: as putCanvas, plus `gone` if the file isn't there any more. */
export async function putLibrary(baseHash: string, content: string):
  Promise<{ ok: true; hash: string } | { ok: false; conflict: { hash: string; library: LibraryFile } } | { ok: false; gone: true }> {
  const res = await fetch("/api/library", { method: "PUT", headers: { "x-base-hash": baseHash, "content-type": "application/json" }, body: content });
  if (res.status === 409) return { ok: false, conflict: await res.json() };
  if (res.status === 404) return { ok: false, gone: true };
  return { ok: true, ...(await reply<{ hash: string }>(res)) };
}
