import assert from "node:assert/strict";
import test from "node:test";
import { readApiPayload } from "../src/api-response.ts";

test("JSON responses pass through and server errors keep their message", async () => {
  assert.deepEqual(
    await readApiPayload(new Response(JSON.stringify({ mode: "sample" }), { status: 200 })),
    { mode: "sample" },
  );
  await assert.rejects(
    readApiPayload(
      new Response(JSON.stringify({ error: "Access key is incorrect" }), { status: 401 }),
    ),
    /Access key is incorrect/,
  );
});

test("plain-text and HTML failures stay readable instead of a JSON parse error", async () => {
  for (const [status, body] of [
    [404, "404 Not Found"],
    [502, "<html><body>Bad Gateway</body></html>"],
  ] as const) {
    const error = await readApiPayload(new Response(body, { status })).catch((e: unknown) => e);
    assert.ok(error instanceof Error);
    assert.equal(error.message, `Request failed (${status})`);
    assert.equal(error instanceof SyntaxError, false);
    assert.doesNotMatch(error.message, /Unexpected|JSON/i);
  }
});

test("a caller fallback covers error bodies without a message", async () => {
  await assert.rejects(
    readApiPayload(
      new Response(JSON.stringify({}), { status: 500 }),
      "Could not open your workspace.",
    ),
    /Could not open your workspace\./,
  );
  await assert.rejects(
    readApiPayload(
      new Response("<html>down</html>", { status: 503 }),
      "Could not open your workspace.",
    ),
    /Could not open your workspace\./,
  );
});

test("successful responses without a readable body fail clearly", async () => {
  await assert.rejects(
    readApiPayload(new Response(null, { status: 204 })),
    /unreadable response \(204\)/,
  );
  await assert.rejects(readApiPayload(new Response("OK", { status: 200 })), /unreadable response/);
});
