import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedDomain, type Resolver, validatePublicUrl } from "../src/network.ts";

const privateResolver: Resolver = async (hostname) => {
  if (hostname === "mysite.example") return [{ address: "10.10.0.10", family: 4 }];
  if (hostname === "public.example") return [{ address: "93.184.216.34", family: 4 }];
  return [];
};

test("untrusted private-IP destinations stay blocked", async () => {
  delete process.env.BROWSER_TRUSTED_DOMAINS;
  await assert.rejects(validatePublicUrl("https://mysite.example", privateResolver), {
    code: "BLOCKED_URL",
  });
});

test("trusted domains may resolve to private IPs", async () => {
  process.env.BROWSER_TRUSTED_DOMAINS = "mysite.example";
  try {
    const result = await validatePublicUrl("https://mysite.example", privateResolver);
    assert.equal(result.address, "10.10.0.10");
    const sub = await validatePublicUrl("https://www.mysite.example", async () => [
      { address: "10.10.0.10", family: 4 },
    ]);
    assert.equal(sub.address, "10.10.0.10");
  } finally {
    delete process.env.BROWSER_TRUSTED_DOMAINS;
  }
});

test("trusted domains still require http(s) on public ports", async () => {
  process.env.BROWSER_TRUSTED_DOMAINS = "mysite.example";
  try {
    await assert.rejects(validatePublicUrl("https://mysite.example:8443", privateResolver), {
      code: "BLOCKED_URL",
    });
    await assert.rejects(validatePublicUrl("ftp://mysite.example", privateResolver), {
      code: "BLOCKED_URL",
    });
  } finally {
    delete process.env.BROWSER_TRUSTED_DOMAINS;
  }
});

test("isTrustedDomain matches exact names and subdomains only", () => {
  process.env.BROWSER_TRUSTED_DOMAINS = "mysite.example, other.test";
  try {
    assert.equal(isTrustedDomain("mysite.example"), true);
    assert.equal(isTrustedDomain("www.mysite.example"), true);
    assert.equal(isTrustedDomain("notmysite.example"), false);
    assert.equal(isTrustedDomain("mysite.example.evil.com"), false);
    assert.equal(isTrustedDomain("other.test"), true);
  } finally {
    delete process.env.BROWSER_TRUSTED_DOMAINS;
  }
});

test("public destinations keep working without any trusted domains", async () => {
  delete process.env.BROWSER_TRUSTED_DOMAINS;
  const result = await validatePublicUrl("https://public.example", privateResolver);
  assert.equal(result.address, "93.184.216.34");
});
