// Localidraw reads and writes files, so only pages it served itself, on this machine, may talk to it.
import type { IncomingMessage, ServerResponse } from "node:http";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * False (after answering 403) for a request that didn't come from a page on localhost: a Host header that isn't
 * localhost (DNS rebinding), or an Origin from any other site (a cross-site write).
 */
export function localOnly(req: IncomingMessage, res: ServerResponse): boolean {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  const ok = LOCAL_HOST.test(host) && (origin === undefined || origin === `http://${host}`);
  if (!ok) res.writeHead(403, { "content-type": "text/plain" }).end("Localidraw only answers pages on localhost.\n");
  return ok;
}
