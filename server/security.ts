// Localidraw reads and writes files, and has no login of its own, so it answers only pages it served itself.
//
// - DNS rebinding: a page on evil.example can have its name resolve to Localidraw's address, and its scripts then
//   talk to "their own origin". The browser still sends `Host: evil.example`, so every request must carry a Host
//   that's loopback or one of the allowed hosts (`--allowed-host`, for a reverse proxy or a server). Anything else
//   is a 403, the page and its files included.
// - Cross-site requests: any page can send a "simple" request (a form, text/plain) to Localidraw without asking, or
//   open an EventSource to it. So an `Origin`, whenever the browser sends one, must be this server as the request
//   reached it: http(s):// plus the Host. The API refuses `Sec-Fetch-Site: cross-site` and `same-site` too (another
//   app on a sibling subdomain is same-site, but not us). And writes must be `application/json`, which no page can
//   send cross-site without a preflight, and Localidraw never grants one: it sends no CORS headers at all.
//
// Authentication, when Localidraw is hosted, is the reverse proxy's job.
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Host names that are always allowed. */
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** A host name as the Host check compares it: lower case, no port, an IPv6 address in brackets. */
export function normalizeHostname(host: string): string {
  const h = host.trim().toLowerCase();
  // `[::1]` or `[::1]:3729`. Anything else after the bracket (`[::1]evil.example`) stays whole, and matches nothing.
  if (h.startsWith("[")) return /^\[[^\]]*\](:\d*)?$/.test(h) ? h.slice(0, h.indexOf("]") + 1) : h;
  if ((h.match(/:/g) ?? []).length > 1) return `[${h}]`; // a bare IPv6 address
  return h.replace(/:\d*$/, "");
}

/**
 * An allowed host as given to `--allowed-host`, normalised, or undefined when it isn't a bare host name or address
 * (it has a scheme, a port, a path or a wildcard).
 */
export function parseAllowedHost(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (isIP(v) === 6) return `[${v}]`;
  if (/^\[[0-9a-f:.]+\]$/.test(v) && isIP(v.slice(1, -1)) === 6) return v;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/.test(v) ? v.replace(/\.$/, "") : undefined;
}

/** True for an address to listen on that only this machine can reach: localhost, 127.x.x.x or ::1. */
export function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return a === "localhost" || a === "::1" || (isIP(a) === 4 && a.startsWith("127."));
}

/** True when `host` (a Host header, port and all) names loopback or an allowed host. */
export function isAllowedHost(host: string | undefined, allowed: readonly string[]): boolean {
  if (!host) return false;
  const h = normalizeHostname(host);
  return LOOPBACK_HOSTNAMES.includes(h) || allowed.includes(h);
}

/**
 * True when `origin` is this server as reached through `host` (the Host header): http or https, then the same
 * host and port. The scheme isn't compared: behind a proxy that does TLS, the server can't know it.
 */
export function isSameOrigin(origin: string, host: string): boolean {
  try {
    const u = new URL(origin);
    // An Origin leaves out the scheme's default port, and a Host header may not.
    return (u.protocol === "http:" || u.protocol === "https:") && u.host === host.trim().toLowerCase().replace(/:(80|443)$/, "");
  } catch {
    return false; // `null` (a sandboxed frame, a file:// page), or garbage
  }
}

const JSON_TYPE = /^application\/json\s*(;|$)/i;

function refuse(res: ServerResponse, status: 403 | 415, message: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`${message}\n`);
  return false;
}

/**
 * False (after answering 403 or 415) for a request that didn't come from a page Localidraw served: a Host that isn't
 * loopback or allowed, an Origin from anywhere else, a cross-site API call, or a write that isn't JSON.
 */
export function guard(req: IncomingMessage, res: ServerResponse, allowedHosts: readonly string[]): boolean {
  const host = req.headers.host;
  if (!isAllowedHost(host, allowedHosts)) {
    return refuse(res, 403, allowedHosts.length
      ? "Localidraw doesn't answer to that host name. To reach it by another name, add it with --allowed-host."
      : "Localidraw only answers pages on localhost.");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isSameOrigin(origin, host!)) return refuse(res, 403, "Localidraw only answers its own pages.");
  const site = req.headers["sec-fetch-site"];
  if (req.url?.startsWith("/api/") && (site === "cross-site" || site === "same-site")) {
    return refuse(res, 403, "Localidraw only answers its own pages.");
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !JSON_TYPE.test(req.headers["content-type"] ?? "")) {
    return refuse(res, 415, "Send JSON (content-type: application/json).");
  }
  return true;
}
