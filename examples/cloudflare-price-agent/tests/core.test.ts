import assert from "node:assert/strict";
import test from "node:test";
import {
  authorized,
  browserRequestUrl,
  completion,
  DemoError,
  type ModelMessage,
  publicUrl,
  readJson,
  requireBrowserTool,
  toolDefinitions,
  verifyEvidence,
} from "../src/core";

test("private demo API rejects missing, partial and incorrect credentials", () => {
  const token = "0123456789012345678901234567890123456789";
  for (const value of ["", `Bearer ${token.slice(1)}`, `Bearer ${"x".repeat(token.length)}`]) {
    assert.equal(
      authorized(
        new Request("https://demo.workers.dev/api/state", { headers: { Authorization: value } }),
        token,
      ),
      false,
    );
  }
  assert.equal(
    authorized(
      new Request("https://demo.workers.dev/api/state", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      token,
    ),
    true,
  );
  assert.equal(authorized(new Request("https://demo.workers.dev"), undefined), false);
});

test("browser navigation rejects local destinations, alternate IP forms, credentials and non-web schemes", () => {
  for (const url of [
    "http://localhost/",
    "http://localhost./",
    "http://service.internal/",
    "http://service.local/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::1]/",
    "https://user:password@shop.com/",
    "https://shop.com:8443/",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])
    assert.throws(() => publicUrl(url), DemoError, url);
  assert.equal(publicUrl("https://shop.com/item?q=1"), "https://shop.com/item?q=1");
});

test("browser request policy permits inline subresources but rejects local and internal schemes", () => {
  assert.equal(
    browserRequestUrl("https://shop.com/image.png", false),
    "https://shop.com/image.png",
  );
  assert.equal(
    browserRequestUrl("data:image/png;base64,AA==", false),
    "data:image/png;base64,AA==",
  );
  assert.equal(
    browserRequestUrl("blob:https://shop.com/asset", false),
    "blob:https://shop.com/asset",
  );
  assert.equal(browserRequestUrl("about:blank", true), "about:blank");
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings/",
    "chrome-extension://id/page.html",
    "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)",
    "ftp://shop.com/file",
    "http://localhost/",
  ]) {
    for (const navigation of [true, false]) {
      assert.throws(() => browserRequestUrl(url, navigation), DemoError, url);
    }
  }
  for (const url of ["data:text/html,private", "blob:https://shop.com/page"])
    assert.throws(() => browserRequestUrl(url, true), DemoError);
});

test("only registered browser actions and price evidence are exposed to the model", () => {
  const expected = [
    "browser_search",
    "browser_navigate",
    "browser_read",
    "browser_click",
    "browser_type",
    "browser_key",
    "browser_scroll",
    "record_price",
  ];
  assert.deepEqual(
    toolDefinitions.map((tool) => tool.function.name),
    expected,
  );
  for (const name of expected.slice(0, -1)) assert.doesNotThrow(() => requireBrowserTool(name));
  for (const name of [
    "read_file",
    "list_files",
    "exec",
    "shell",
    "browser_evaluate",
    "browser_read_file",
    "record_price",
  ])
    assert.throws(
      () => requireBrowserTool(name),
      (error: unknown) => error instanceof DemoError && error.code === "blocked_tool",
    );
});

const observation = {
  url: "https://shop.com/item/a",
  text: "商品：演示耳机 A\n商品价格：¥9,800\n币种 JPY，含税，不含运费。",
  observedAt: "2026-10-19T12:00:00.000Z",
};
const evidence = { name: "演示耳机 A", priceText: "¥9,800", currency: "JPY", url: observation.url };

test("price records retain exact observed price, source and observation time", () => {
  const result = verifyEvidence(evidence, observation);
  assert.equal(result.priceText, "¥9,800");
  assert.equal(result.observedAt, observation.observedAt);
  assert.equal(result.url, observation.url);
});

test("price records reject invented amounts, product names and unrelated source URLs", () => {
  for (const patch of [
    { priceText: "¥8,000" },
    { name: "演示耳机 B" },
    { url: "https://other-shop.com/item/a" },
    { url: "https://shop.com/item/b" },
    { currency: "JPYJPY" },
  ])
    assert.throws(() => verifyEvidence({ ...evidence, ...patch }, observation), DemoError);
  assert.throws(() => verifyEvidence(evidence, null), DemoError);
});

test("invalid upstream JSON produces a controlled error, never an Unexpected token exception", async () => {
  await assert.rejects(
    readJson(new Response("Internal Server Error")),
    (error: unknown) => error instanceof DemoError && error.code === "invalid_json",
  );
});

test("malformed client JSON is a client error rather than an upstream failure", async () => {
  const request = new Request("https://demo.workers.dev/api/chat", {
    method: "POST",
    body: "invalid",
  });
  await assert.rejects(
    readJson(request),
    (error: unknown) => error instanceof DemoError && error.status === 400,
  );
});

test("body limits apply to actual UTF-8 bytes even without Content-Length", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"内容":"'));
      controller.enqueue(new TextEncoder().encode("中".repeat(20)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  await assert.rejects(
    readJson(new Response(body), 40),
    (error: unknown) => error instanceof DemoError && error.status === 413,
  );
});

test("DeepSeek requests preserve multi-turn tool results and explicitly disable thinking", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "查这款耳机价格" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "browser_read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: JSON.stringify(observation) },
    { role: "assistant", content: "页面价格为 ¥9,800。" },
    { role: "user", content: "是否含税？" },
  ];
  let sent: Record<string, unknown> | undefined;
  const answer = await completion(
    "test-key",
    "deepseek-flash",
    messages,
    new AbortController().signal,
    async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      sent = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { role: "assistant", content: "页面写明含税，不含运费。" } }],
      });
    },
  );
  assert.equal(answer.content, "页面写明含税，不含运费。");
  assert.equal(sent?.model, "deepseek-flash");
  assert.deepEqual(sent?.messages, messages);
  assert.deepEqual(sent?.thinking, { type: "disabled" });
  assert.equal(JSON.stringify(sent).includes("deepseek-pro"), false);
});

test("model tool calls retain their exact IDs for tool-result replay", async () => {
  const tool = {
    id: "call-42",
    type: "function",
    function: { name: "browser_navigate", arguments: '{"url":"https://shop.com"}' },
  };
  const answer = await completion(
    "key",
    "deepseek-flash",
    [],
    new AbortController().signal,
    async () => Response.json({ choices: [{ message: { content: null, tool_calls: [tool] } }] }),
  );
  assert.deepEqual(answer.tool_calls, [tool]);
});

test("upstream failures and empty responses cannot be reported as successful answers", async () => {
  await assert.rejects(
    completion(
      "key",
      "deepseek-flash",
      [],
      new AbortController().signal,
      async () => new Response("upstream private details", { status: 429 }),
    ),
    (error: unknown) =>
      error instanceof DemoError &&
      error.message.includes("HTTP 429") &&
      !error.message.includes("private"),
  );
  for (const data of [{ choices: [] }, { choices: [{ message: { content: "" } }] }]) {
    await assert.rejects(
      completion("key", "deepseek-flash", [], new AbortController().signal, async () =>
        Response.json(data),
      ),
      DemoError,
    );
  }
});

test("model calls receive cancellation and do not ignore an explicit stop", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    completion("key", "deepseek-flash", [], controller.signal, async (_url, init) => {
      init?.signal?.throwIfAborted();
      return Response.json({});
    }),
  );
});
