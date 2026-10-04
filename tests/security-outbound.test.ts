import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardedEndpoint } from "../apps/server/src/config.ts";
import {
  applyUrlGuard,
  applyUrlGuardWithDns,
  CLOUD_METADATA_BLOCKED_MESSAGE,
  isCloudMetadataHost,
  isPrivateHost,
  OutboundUrlGuardError,
  outboundGuardMode,
  PRIVATE_OUTBOUND_URLS_ENV,
  PRIVATE_URL_BLOCKED_MESSAGE,
  PUBLIC_ONLY_OUTBOUND_URLS_ENV,
  resolveOutboundHost,
} from "../apps/server/src/security/outbound-url-guard.ts";

/** Resolver stub: no DNS, so every rebinding case is deterministic. */
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("outbound url guard: lexical classification", () => {
  it("treats an empty host as private rather than guessing", () => {
    assert.equal(isPrivateHost(""), true);
  });

  it("blocks the private and reserved IPv4 ranges", () => {
    for (const host of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "100.64.0.1",
    ])
      assert.equal(isPrivateHost(host), true, host);
  });

  it("allows public IPv4 and does not confuse a neighbouring range", () => {
    for (const host of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"])
      assert.equal(isPrivateHost(host), false, host);
  });

  it("blocks loopback, .local and .internal by name", () => {
    for (const host of ["localhost", "app.localhost", "printer.local", "metadata.google.internal"])
      assert.equal(isPrivateHost(host), true, host);
  });

  it("blocks the IPv6 forms that route to a private IPv4 destination", () => {
    // ::ffff: matches by prefix; ::7f00:1 is the deprecated IPv4-COMPATIBLE form
    // with no `ffff:` marker, which a prefix test alone would pass.
    assert.equal(isPrivateHost("::ffff:169.254.169.254"), true);
    assert.equal(isPrivateHost("::ffff:a9fe:a9fe"), true);
    assert.equal(isPrivateHost("::7f00:1"), true);
    assert.equal(isPrivateHost("::1"), true);
    assert.equal(isPrivateHost("::"), true);
    assert.equal(isPrivateHost("fd00::1"), true);
    assert.equal(isPrivateHost("fe80::1"), true);
  });

  it("blocks cloud metadata unconditionally, including via a mapped literal", () => {
    for (const host of [
      "169.254.169.254",
      "169.254.1.1",
      "metadata.google.internal",
      "100.100.100.200",
      "fd00:ec2::254",
    ])
      assert.equal(isCloudMetadataHost(host), true, host);
    // WHATWG URL canonicalizes the embedded IPv4 into hex groups, so a string
    // test for "169.254." never fires on what URL actually produces.
    assert.equal(new URL("http://[::ffff:169.254.169.254]/").hostname, "[::ffff:a9fe:a9fe]");
    assert.equal(isCloudMetadataHost("[::ffff:a9fe:a9fe]"), true);
  });

  it("rejects non-HTTP protocols and embedded credentials", () => {
    assert.throws(
      () => applyUrlGuard("file:///etc/passwd", "public-only"),
      (error: unknown) =>
        error instanceof OutboundUrlGuardError && error.code === "OUTBOUND_URL_INVALID",
    );
    assert.throws(
      () => applyUrlGuard("https://user:secret@example.com", "block-metadata"),
      (error: unknown) =>
        error instanceof OutboundUrlGuardError && error.code === "OUTBOUND_URL_GUARD_BLOCKED",
    );
  });
});

describe("outbound url guard: policy modes", () => {
  it("defaults to block-metadata so a worker on loopback still works", () => {
    assert.equal(outboundGuardMode({}), "block-metadata");
    assert.doesNotThrow(() => applyUrlGuard("http://127.0.0.1:8080", "block-metadata"));
    assert.throws(() => applyUrlGuard("http://169.254.169.254/", "block-metadata"), {
      message: CLOUD_METADATA_BLOCKED_MESSAGE,
    });
  });

  it("honours the public-only opt-in and the full opt-out, in that precedence", () => {
    assert.equal(outboundGuardMode({ [PUBLIC_ONLY_OUTBOUND_URLS_ENV]: "true" }), "public-only");
    assert.equal(outboundGuardMode({ [PRIVATE_OUTBOUND_URLS_ENV]: "yes" }), "none");
    assert.equal(
      outboundGuardMode({ [PRIVATE_OUTBOUND_URLS_ENV]: "1", [PUBLIC_ONLY_OUTBOUND_URLS_ENV]: "1" }),
      "none",
    );
    // "off" is not truthy: the opt-ins are affirmative, not merely non-empty.
    assert.equal(outboundGuardMode({ [PRIVATE_OUTBOUND_URLS_ENV]: "off" }), "block-metadata");
  });

  it("public-only refuses a private host that block-metadata permits", () => {
    assert.throws(() => applyUrlGuard("http://10.0.0.5:9000", "public-only"));
    assert.doesNotThrow(() => applyUrlGuard("http://10.0.0.5:9000", "block-metadata"));
  });
});

describe("outbound url guard: resolve-then-validate", () => {
  it("refuses a public name whose ADDRESS is cloud metadata", async () => {
    // The lexical guard passes this — it only ever saw the string. This is the
    // whole point of resolving.
    assert.doesNotThrow(() => applyUrlGuard("http://evil.example/", "public-only"));
    await assert.rejects(
      resolveOutboundHost("evil.example", "public-only", resolvesTo("169.254.169.254")),
      { message: CLOUD_METADATA_BLOCKED_MESSAGE },
    );
  });

  it("refuses when ANY returned address is blocked, not only the first", async () => {
    await assert.rejects(
      resolveOutboundHost(
        "rebind.example",
        "public-only",
        resolvesTo("93.184.216.34", "127.0.0.1"),
      ),
    );
  });

  it("fails closed on a lookup error and on an empty answer", async () => {
    await assert.rejects(
      resolveOutboundHost("broken.example", "block-metadata", async () => {
        throw new Error("ENOTFOUND");
      }),
      (error: unknown) =>
        error instanceof OutboundUrlGuardError && error.code === "OUTBOUND_URL_INVALID",
    );
    await assert.rejects(
      resolveOutboundHost("empty.example", "block-metadata", resolvesTo()),
      (error: unknown) =>
        error instanceof OutboundUrlGuardError && error.code === "OUTBOUND_URL_INVALID",
    );
  });

  it("refuses a malformed resolver record instead of reading it as harmless", async () => {
    // A garbage record must not reach isIP as "[object Object]" and pass as
    // "not an IP, therefore fine". It fails closed through the empty-is-private
    // rule, so the message is the private-blocked one, not the metadata one.
    await assert.rejects(
      resolveOutboundHost("weird.example", "block-metadata", async () => [
        { nonsense: true } as unknown as { address: string; family: number },
      ]),
      { message: PRIVATE_URL_BLOCKED_MESSAGE },
    );
  });

  it("passes an IP literal through the same exit path without resolving it", async () => {
    const resolved = await resolveOutboundHost("8.8.8.8", "public-only", async () => {
      throw new Error("must not be called for an IP literal");
    });
    assert.deepEqual(resolved, { hostname: "8.8.8.8", addresses: ["8.8.8.8"] });
  });

  it("skips both passes entirely under the full opt-out", async () => {
    const guarded = await applyUrlGuardWithDns("http://169.254.169.254/", "none", async () => {
      throw new Error("must not resolve under mode 'none'");
    });
    assert.deepEqual(guarded.addresses, []);
  });
});

describe("guardedEndpoint", () => {
  it("passes a blank value through as unset", () => {
    assert.equal(guardedEndpoint("AGENT_URL", undefined), undefined);
    assert.equal(guardedEndpoint("AGENT_URL", "   "), undefined);
  });

  it("normalizes an acceptable endpoint and fails startup loudly on a blocked one", () => {
    const mode = process.env[PRIVATE_OUTBOUND_URLS_ENV];
    process.env[PRIVATE_OUTBOUND_URLS_ENV] = "1";
    try {
      assert.equal(
        guardedEndpoint("BROWSER_WORKER_URL", "http://worker:8080"),
        "http://worker:8080/",
      );
      // Even the full opt-out keeps the protocol and credential checks.
      assert.throws(() => guardedEndpoint("AGENT_URL", "file:///etc/passwd"), /AGENT_URL/);
    } finally {
      if (mode === undefined) delete process.env[PRIVATE_OUTBOUND_URLS_ENV];
      else process.env[PRIVATE_OUTBOUND_URLS_ENV] = mode;
    }
  });

  it("names the variable in the failure so the operator knows what to fix", () => {
    const previous = process.env[PUBLIC_ONLY_OUTBOUND_URLS_ENV];
    process.env[PUBLIC_ONLY_OUTBOUND_URLS_ENV] = "1";
    try {
      assert.throws(() => guardedEndpoint("BROWSER_WORKER_URL", "http://127.0.0.1:8080"), {
        message: /BROWSER_WORKER_URL is not an acceptable outbound destination/,
      });
    } finally {
      if (previous === undefined) delete process.env[PUBLIC_ONLY_OUTBOUND_URLS_ENV];
      else process.env[PUBLIC_ONLY_OUTBOUND_URLS_ENV] = previous;
    }
  });
});
