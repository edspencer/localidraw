// Sending the page and its files: caching, and compression from node:zlib when the browser takes it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

/** Text compresses; fonts and images already are. */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".ttf"]);

/**
 * A file whose name carries a hash of its content, so it never changes: esbuild's chunks and assets
 * (`chunk-O7ESXKUI.js`, the build's `[name]-[hash]`) and Excalidraw's own font files (`…-<md5>.woff2`). Everything
 * else is revalidated on each load (`no-cache`, with an ETag), so a new version of Localidraw is picked up at once.
 */
export const isHashed = (path: string) => /-([A-Z0-9]{8}|[0-9a-f]{32})\.[a-z0-9]+$/.test(basename(path));

export const IMMUTABLE = "public, max-age=31536000, immutable";

type Encoding = "br" | "gzip";

/** The best encoding the request accepts: brotli, then gzip, or none. */
export function encodingFor(req: IncomingMessage): Encoding | undefined {
  const accepted = new Map<string, number>();
  for (const part of String(req.headers["accept-encoding"] ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name) accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const ok = (e: string) => (accepted.get(e) ?? accepted.get("*") ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : undefined;
}

const br = promisify(brotliCompress);
const gz = promisify(gzip);

/** Compresses `body`. Brotli at `quality`: 9 for the page's files (done once, then kept), lower for the API's. */
export const compress = (body: Buffer, encoding: Encoding, quality: number) =>
  encoding === "br"
    ? br(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gz(body);

/** Sends `body`, compressed when the type and the request allow it and it's worth it. */
export async function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer, quality = 4) {
  const encoding = body.length >= 1024 ? encodingFor(req) : undefined;
  if (!encoding) return res.writeHead(status, { ...headers, vary: "accept-encoding" }).end(body);
  const packed = await compress(body, encoding, quality);
  res.writeHead(status, { ...headers, vary: "accept-encoding", "content-encoding": encoding }).end(packed);
}

/**
 * Serves the files under one folder (the built page): each read once and kept, with its compressed copies, since the
 * build doesn't change while it runs. Hashed files are cached for good; the rest are revalidated against an ETag.
 */
export function staticFiles(base: string) {
  type Entry = { body: Buffer; etag: string; packed: Partial<Record<Encoding, Promise<Buffer>>> };
  const cache = new Map<string, Entry>();
  const load = (abs: string): Entry | undefined => {
    const stat = statSync(abs);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    let entry = cache.get(abs);
    if (!entry || entry.etag !== etag) cache.set(abs, (entry = { body: readFileSync(abs), etag, packed: {} }));
    return entry;
  };

  return async function serve(req: IncomingMessage, res: ServerResponse, rel: string) {
    let abs: string;
    try { abs = resolve(base, decodeURIComponent(rel)); } catch { return res.writeHead(400).end(); }
    if (!abs.startsWith(base + sep) || !existsSync(abs) || !statSync(abs).isFile()) return res.writeHead(404).end();
    const entry = load(abs)!;
    const ext = extname(abs);
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": isHashed(abs) ? IMMUTABLE : "no-cache",
      etag: entry.etag,
    };
    if (COMPRESSIBLE.has(ext)) headers.vary = "accept-encoding";
    if (req.headers["if-none-match"] === entry.etag) return res.writeHead(304, headers).end();
    const encoding = COMPRESSIBLE.has(ext) && entry.body.length >= 1024 ? encodingFor(req) : undefined;
    if (!encoding) return res.writeHead(200, headers).end(entry.body);
    const packed = await (entry.packed[encoding] ??= compress(entry.body, encoding, 9));
    res.writeHead(200, { ...headers, "content-encoding": encoding }).end(packed);
  };
}
