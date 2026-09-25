import assert from "node:assert/strict";
import test from "node:test";
import { browserAddress, browserErrorSummary } from "../src/browser-address.ts";

test("the browser address bar accepts domains and keeps explicit web URLs", () => {
  assert.equal(browserAddress(" copilotkit.ai "), "https://copilotkit.ai/");
  assert.equal(
    browserAddress("news.ycombinator.com/newest"),
    "https://news.ycombinator.com/newest",
  );
  assert.equal(browserAddress("http://example.com/?q=one#two"), "http://example.com/?q=one#two");
});
test("the address bar rejects unsupported schemes, credentials, and malformed inputs", () => {
  for (const input of [
    "",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "hello world",
  ])
    assert.throws(() => browserAddress(input), /Enter a website address/);
});
test("browser error summaries stay honest about the real failure cause", () => {
  assert.equal(
    browserErrorSummary("Close an active session before opening another (limit 3)."),
    "Browser session limit reached",
  );
  assert.equal(
    browserErrorSummary(
      "The page could not be loaded. It may be unreachable or contain a blocked destination.",
    ),
    "The page couldn't be loaded",
  );
  assert.equal(
    browserErrorSummary("Browser worker is not configured. Start it using the setup guide."),
    "Browser worker unavailable",
  );
  assert.equal(
    browserErrorSummary("Public page could not be opened"),
    "Public page could not be opened",
  );
  const long = `x`.repeat(200);
  assert.equal(browserErrorSummary(long), `${"x".repeat(110)}…`);
});
