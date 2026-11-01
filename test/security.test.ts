import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedHost, isLoopbackAddress, isSameOrigin, normalizeHostname, parseAllowedHost } from "../server/security.ts";

test("host names are compared without their port, in lower case, with IPv6 in brackets", () => {
  assert.equal(normalizeHostname("Draw.Example:3729"), "draw.example");
  assert.equal(normalizeHostname("[::1]:3729"), "[::1]");
  assert.equal(normalizeHostname("::1"), "[::1]");
  assert.equal(normalizeHostname("[::1]evil.example"), "[::1]evil.example");
  assert.equal(isAllowedHost("localhost:3729", []), true);
  assert.equal(isAllowedHost("127.0.0.1", []), true);
  assert.equal(isAllowedHost("draw.example", []), false);
  assert.equal(isAllowedHost("draw.example", ["draw.example"]), true);
  assert.equal(isAllowedHost(undefined, ["draw.example"]), false);
});

test("an allowed host is a bare name or address", () => {
  assert.equal(parseAllowedHost(" Draw.Example "), "draw.example");
  assert.equal(parseAllowedHost("draw.example."), "draw.example");
  assert.equal(parseAllowedHost("192.168.1.5"), "192.168.1.5");
  assert.equal(parseAllowedHost("fd00::1"), "[fd00::1]");
  assert.equal(parseAllowedHost("[fd00::1]"), "[fd00::1]");
  for (const bad of ["", "http://draw.example", "draw.example:3729", "draw.example/x", "*.example", "-draw.example", "a b", "[nope]"]) {
    assert.equal(parseAllowedHost(bad), undefined, bad);
  }
});

test("only localhost, 127.x and ::1 are loopback; 0.0.0.0 and :: are every address", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["0.0.0.0", "::", "[::]", "192.168.1.5", "draw.example", "127.0.0.1.evil.example"]) assert.equal(isLoopbackAddress(a), false, a);
});

test("an Origin is the same when it's http(s) and the request's own host and port", () => {
  assert.equal(isSameOrigin("http://localhost:3729", "localhost:3729"), true);
  assert.equal(isSameOrigin("https://draw.example", "draw.example"), true);
  assert.equal(isSameOrigin("https://draw.example", "draw.example:443"), true);
  assert.equal(isSameOrigin("http://draw.example", "draw.example:80"), true);
  assert.equal(isSameOrigin("https://draw.example:8443", "draw.example"), false);
  assert.equal(isSameOrigin("https://evil.example", "draw.example"), false);
  assert.equal(isSameOrigin("null", "draw.example"), false);
  assert.equal(isSameOrigin("ws://draw.example", "draw.example"), false);
});
