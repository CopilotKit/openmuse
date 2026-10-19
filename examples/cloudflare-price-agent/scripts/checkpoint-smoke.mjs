// Explicit live acceptance: creates demo conversations and uses the configured model/browser.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const base = new URL(process.env.OPENMUSE_DEMO_URL || "http://127.0.0.1:8791");
const marker = randomUUID();
const evidence = { marker, checkedAt: new Date().toISOString() };
let conversationId;

async function api(path, body, expectedStatus = 200) {
  const response = await fetch(new URL(`/api/${path}`, base), {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(process.env.DEMO_ACCESS_TOKEN
        ? { Authorization: `Bearer ${process.env.DEMO_ACCESS_TOKEN}` }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(360_000),
  });
  const payload = await response.json();
  assert.equal(
    response.status,
    expectedStatus,
    `${path}: ${payload.error?.message || "unexpected status"}`,
  );
  return payload;
}

const state = () => api(`state?conversationId=${conversationId}`);
const operation = (name) => api(`browser/${name}`, { conversationId });
async function chat(prompt) {
  const result = await api("chat", { conversationId, requestId: randomUUID(), prompt });
  if (result.status !== "done") evidence.lastFailure = result;
  assert.equal(result.status, "done", result.answer);
  return result;
}

try {
  const health = await api("health");
  const initial = await api("state");
  assert.equal(initial.running, null, "Wait until the current task has finished");
  conversationId = (await api("conversations", {})).id;
  evidence.conversationId = conversationId;
  const fixture = new URL("/demo-catalog/checkpoint-test", health.catalogUrl);
  fixture.searchParams.set("seed", marker);
  evidence.initialRead = await chat(
    `存档恢复测试：仅打开一次 ${fixture.href}，读取页面上的三个验证值并原样报告。它们是虚构测试数据。失败立即停止，不要重试或搜索。`,
  );
  let snapshot = await state();
  assert.ok(snapshot.checkpoint, snapshot.checkpointError || "Automatic checkpoint missing");
  assert.ok(snapshot.checkpoint.cookieCount >= 1);
  assert.equal(snapshot.checkpoint.storageItems, 2);
  assert.equal(
    new URL(snapshot.checkpoint.url).search,
    "",
    "Restoring must not reseed the fixture",
  );
  const originalId = snapshot.browser.sessionId;
  evidence.originalSessionId = originalId;
  await operation("save");
  await operation("disconnect");
  snapshot = await state();
  assert.equal(snapshot.browser.connection, "disconnected");
  assert.equal((await api(`browser/live?conversationId=${conversationId}`)).url, null);
  assert.equal((await operation("reconnect")).mode, "reconnected");
  snapshot = await state();
  assert.equal(snapshot.browser.sessionId, originalId);
  evidence.sameSessionReconnect = true;

  await operation("save-close");
  snapshot = await state();
  assert.equal(snapshot.browser, null);
  assert.ok(snapshot.checkpoint);
  assert.equal((await operation("reconnect")).mode, "restored");
  snapshot = await state();
  assert.notEqual(snapshot.browser.sessionId, originalId);
  evidence.restoredSessionId = snapshot.browser.sessionId;
  assert.equal(snapshot.browser.restoredFromCheckpoint, true);
  const read = await chat(
    "只调用 browser_read 读取当前页，逐项原样报告 HttpOnly Cookie、localStorage 和 sessionStorage 显示的值。不要导航，也不要写入任何数据；如未设置请如实说明。",
  );
  snapshot = await state();
  assert.ok(snapshot.events.some((event) => event.message === "执行 browser_read"));
  assert.equal(
    snapshot.events.some((event) => event.message === "执行 browser_navigate"),
    false,
  );
  assert.ok(read.answer.split(marker).length >= 4, "All three marker values must survive");
  evidence.restoredRead = read;
  evidence.checkpoint = snapshot.checkpoint;
  assert.equal(
    JSON.stringify(snapshot.checkpoint).includes(marker),
    false,
    "Checkpoint API metadata must not expose cookie/storage values",
  );
  await mkdir(".wrangler", { recursive: true });
  await writeFile(".wrangler/checkpoint-restored.jpg", Buffer.from(snapshot.screenshot, "base64"));

  const cleared = await chat(
    "点击当前页面的“清空本页站点存储”，然后重新导航当前网址 /demo-catalog/checkpoint-test（使用当前站点完整网址，不要添加 seed 参数）。读取并分别报告 localStorage、sessionStorage。",
  );
  snapshot = await state();
  assert.ok(cleared.answer.split("未设置").length >= 3);
  assert.equal(
    snapshot.checkpoint.storageItems,
    0,
    "Old restore scripts must not replay on later loads",
  );
  evidence.clearedRead = cleared;
  await operation("save-close");
  assert.equal((await state()).browser, null);

  const other = (await api("conversations", {})).id;
  assert.equal((await api(`state?conversationId=${other}`)).checkpoint, null);
  await api("browser/reconnect", { conversationId: other }, 404);
  await api("browser/forget", { conversationId: other });
  assert.ok((await state()).checkpoint, "Another conversation must not delete this checkpoint");
  evidence.conversationIsolation = true;
  await operation("forget");
  assert.equal((await state()).checkpoint, null);
  evidence.forgetVerified = true;
  evidence.allPassed = true;
  console.log(
    JSON.stringify({
      allPassed: true,
      sameSessionReconnect: true,
      freshBrowserRestore: true,
      restoredHttpOnlyCookieAndBothStorageTypes: true,
      noRepeatedStorageInjection: true,
      conversationIsolation: true,
      forgetVerified: true,
    }),
  );
} finally {
  if (conversationId) {
    const current = await state();
    if (current.running?.conversationId === conversationId) await api("stop", {});
    if (current.browser) await api("browser/close", {});
  }
  await mkdir(".wrangler", { recursive: true });
  await writeFile(".wrangler/checkpoint-acceptance.json", JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
}
