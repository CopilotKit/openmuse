import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOST_EXEC_CONTROLS,
  type HostExecSurface,
  hostExecGate,
} from "../apps/server/src/security/host-exec-gate.ts";
import {
  isCorsSimpleWrite,
  isCrossSiteRequest,
  isLocalWebSocketOrigin,
  isLoopbackAddress,
} from "../apps/server/src/security/request-origin.ts";

const request = (headers: Record<string, string>, method = "POST") => ({
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  method,
});

describe("request origin: cross-site detection", () => {
  it("refuses a page on another site, by Origin or by Sec-Fetch-Site", () => {
    assert.equal(isCrossSiteRequest(request({ origin: "https://evil.example" })).allowed, false);
    assert.equal(isCrossSiteRequest(request({ origin: "null" })).allowed, false);
    assert.equal(isCrossSiteRequest(request({ "sec-fetch-site": "cross-site" })).allowed, false);
  });

  it("treats same-site as disqualifying: a sibling subdomain is not this origin", () => {
    assert.equal(isCrossSiteRequest(request({ "sec-fetch-site": "same-site" })).allowed, false);
  });

  it("allows the local origins the product actually serves from", () => {
    for (const origin of [
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://[::1]:8081",
      "http://localhost",
    ])
      assert.equal(isCrossSiteRequest(request({ origin })).allowed, true, origin);
  });

  it("allows a non-browser caller that sends no Origin at all", () => {
    // The Expo client, curl and the test harness send none. Failing closed on
    // absence would break them to defend against an attacker who is not the
    // threat model — a CSRF attack is mounted through a browser.
    assert.equal(isCrossSiteRequest(request({})).allowed, true);
    assert.equal(isCrossSiteRequest(request({ origin: "" })).allowed, true);
  });

  it("fails closed on an Origin it cannot parse", () => {
    assert.equal(isCrossSiteRequest(request({ origin: "not a url" })).allowed, false);
  });

  it("does not accept a public name that merely resembles a loopback address", () => {
    // cntrl's source regex tested /^127\.|^::1$|^localhost$/, whose `^127\.`
    // alternative is an unanchored PREFIX over a hostname rather than an
    // address test. These are all attacker-registrable public DNS names, and
    // the inconsistency gave the defect away: the `localhost` alternative in
    // the same regex WAS fully anchored.
    for (const host of ["127.evil.example", "127.0.0.1.nip.io", "localhost.evil.example"])
      assert.equal(isCrossSiteRequest(request({ origin: `http://${host}` })).allowed, false, host);
  });

  it("accepts the whole of 127.0.0.0/8, not just 127.0.0.1", () => {
    // A loopback address is loopback by definition; refusing 127.0.0.2 would be
    // the same lexical-vs-identity error in the opposite direction.
    assert.equal(isLoopbackAddress("127.0.0.2"), true);
    assert.equal(isLoopbackAddress("127.255.255.254"), true);
    assert.equal(isCrossSiteRequest(request({ origin: "http://127.0.0.2:8081" })).allowed, true);
    // And the boundary just outside it is not.
    assert.equal(isLoopbackAddress("128.0.0.1"), false);
    assert.equal(isLoopbackAddress("126.255.255.255"), false);
  });
});

describe("request origin: cors-simple writes", () => {
  it("refuses the three content types a browser can send without a preflight", () => {
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "text/plain; charset=utf-8",
    ])
      assert.equal(isCorsSimpleWrite(request({ "content-type": type })).allowed, false, type);
  });

  it("allows JSON, which the browser must preflight", () => {
    assert.equal(isCorsSimpleWrite(request({ "content-type": "application/json" })).allowed, true);
  });

  it("allows an absent content type: that is not the attack shape", () => {
    assert.equal(isCorsSimpleWrite(request({})).allowed, true);
  });

  it("does not classify reads as writes", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"])
      assert.equal(
        isCorsSimpleWrite(request({ "content-type": "text/plain" }, method)).allowed,
        true,
        method,
      );
  });
});

describe("request origin: websocket upgrades", () => {
  it("refuses a cross-site upgrade origin, which Host could never reveal", () => {
    assert.equal(isLocalWebSocketOrigin("https://evil.example").allowed, false);
    assert.equal(isLocalWebSocketOrigin("null").allowed, false);
  });

  it("allows a loopback origin and a missing one", () => {
    assert.equal(isLocalWebSocketOrigin("http://localhost:8787").allowed, true);
    // Browsers always send Origin on a WS handshake, so absence means a
    // non-browser client rather than the hijacking threat model.
    assert.equal(isLocalWebSocketOrigin(null).allowed, true);
  });
});

describe("host exec gate", () => {
  it("refuses a cors-simple write to every process-execution surface", () => {
    for (const surface of Object.keys(HOST_EXEC_CONTROLS) as HostExecSurface[]) {
      if (!HOST_EXEC_CONTROLS[surface].corsSimpleWrite) continue;
      const outcome = hostExecGate(request({ "content-type": "text/plain" }), surface);
      assert.equal(outcome.refused, true, surface);
    }
  });

  it("refuses a cross-site request to every surface, including the guarded one", () => {
    for (const surface of Object.keys(HOST_EXEC_CONTROLS) as HostExecSurface[]) {
      const outcome = hostExecGate(request({ origin: "https://evil.example" }), surface);
      assert.equal(outcome.refused, true, surface);
    }
  });

  it("allows a preflighted same-origin write", () => {
    for (const surface of Object.keys(HOST_EXEC_CONTROLS) as HostExecSurface[]) {
      const outcome = hostExecGate(
        request({ origin: "http://localhost:8081", "content-type": "application/json" }),
        surface,
      );
      assert.equal(outcome.refused, false, surface);
    }
  });

  it("allows a non-browser caller, which is how the Expo client reaches these", () => {
    for (const surface of Object.keys(HOST_EXEC_CONTROLS) as HostExecSurface[]) {
      assert.equal(hostExecGate(request({}), surface).refused, false, surface);
    }
  });

  it("fails closed on a missing request and on an unknown surface", () => {
    assert.equal(hostExecGate(null, "computer.command").refused, true);
    assert.equal(
      hostExecGate(request({}), "computer.command.doesNotExist" as HostExecSurface).refused,
      true,
    );
  });

  it("holds every computer surface to at least the strength of computer.command", () => {
    // A weaker row on a sibling surface would let the same capability be reached
    // by a route that looks less dangerous. The shell is the strict superset.
    const baseline = HOST_EXEC_CONTROLS["computer.command"];
    for (const surface of Object.keys(HOST_EXEC_CONTROLS) as HostExecSurface[]) {
      if (!surface.startsWith("computer.")) continue;
      assert.equal(HOST_EXEC_CONTROLS[surface].corsSimpleWrite, baseline.corsSimpleWrite, surface);
      assert.equal(HOST_EXEC_CONTROLS[surface].crossSite, baseline.crossSite, surface);
    }
  });

  it("does not apply the cors-simple rule to the JSON-only approval route", () => {
    // action.decide is irreversible but does not execute anything; the rule is
    // scoped to surfaces whose bodies are parsed as JSON and reached by writes
    // that must be preflighted. Documented in the table.
    const outcome = hostExecGate(request({ "content-type": "text/plain" }), "action.decide");
    assert.equal(outcome.refused, false);
    // It still refuses a cross-site request.
    assert.equal(
      hostExecGate(request({ origin: "https://evil.example" }), "action.decide").refused,
      true,
    );
  });
});
