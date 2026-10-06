import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Sandbox } from "@e2b/desktop";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../server/src/app.ts";
import { ComputerService, computerIdentity } from "../server/src/computer.ts";
import type { Config } from "../server/src/config.ts";
import { createStore } from "../server/src/db.ts";

// Explicit opt-in script against real E2B: a unique deployment, and every sandbox it
// creates is killed afterwards. Run: E2B_API_KEY=... pnpm test:computer:e2b-desktop
const apiKey = process.env.E2B_API_KEY?.trim();
test("real E2B desktop runs commands, opens GUI apps, streams, acts, persists files and stops active work", {
  timeout: 300000,
  skip: !apiKey && "set E2B_API_KEY to run the E2B desktop smoke test",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-e2b-desktop-smoke-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
    computerEnabled: true,
    computerProvider: "e2b-desktop",
    computerE2bTemplate: process.env.COMPUTER_E2B_TEMPLATE ?? "desktop",
    e2bApiKey: apiKey,
    computerDeploymentId: `smoke-${randomUUID()}`,
  };
  const server = await createApp(db, config);
  const owner = "local-user",
    labels = computerIdentity(config, owner).labels;
  const sandboxIds = async () =>
    (
      await Sandbox.list({
        apiKey,
        query: { metadata: labels, state: ["running", "paused"] },
      }).nextItems()
    ).map((item) => item.sandboxId);
  try {
    const session = await server.auth.session();
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    const call = async (path: string, body?: unknown) => {
      const response = await server.app.request(`/api/computer${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
      return result;
    };
    const post = (path: string, body: unknown = {}) => call(path, body);
    // A desktop action, then the JPEG screenshot it kept for the chat card.
    const act = async (action: Record<string, unknown>) => {
      const result = await post("/desktop/actions", action);
      assert.equal(result.receipt.status, "succeeded", JSON.stringify(result));
      assert.deepEqual([result.width, result.height], [1280, 800]);
      const response = await server.app.request("/api/computer/desktop/screenshot", { headers });
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      assert.ok(bytes.length > 5000 && bytes.length < 1024 * 1024, String(bytes.length));
      return bytes;
    };
    const started = await post("/start");
    assert.equal(started.status, "running");
    assert.equal(started.provider, "e2b-desktop");
    assert.equal(started.network, "enabled");
    assert.equal((await sandboxIds()).length, 1);
    const command = await post("/commands", {
      command:
        "id -u; pwd; python3 --version; git --version; printf 'persisted from bash\\n' > receipt.txt",
    });
    assert.equal(command.status, "succeeded", JSON.stringify(command));
    assert.match(command.stdout, /^1000\n\/workspace\nPython 3\./);
    await post("/files/mkdir", { path: "/workspace/notes" });
    await post("/files/write", {
      path: "/workspace/notes/hello.txt",
      text: "Hello from the API ✓",
    });
    assert.equal(
      (await post("/files/read", { path: "/workspace/notes/hello.txt" })).text,
      "Hello from the API ✓",
    );
    const missing = await post("/commands", { command: "pwd", cwd: "/workspace/missing" });
    assert.equal(missing.status, "failed");
    assert.equal(missing.exitCode, 126);
    const stdout = await post("/commands", { command: "python3 -c 'print(\"x\" * 300000)'" });
    assert.equal(stdout.status, "succeeded");
    assert.equal(stdout.truncated, true);
    assert.ok(Buffer.byteLength(stdout.stdout) <= 128 * 1024);
    await post("/commands", { command: "ln -s /etc /workspace/escape" });
    const escaped = await server.app.request("/api/computer/files/read", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/workspace/escape/passwd" }),
    });
    assert.equal(escaped.status, 422);
    // A backgrounded GUI app must not hold the command open, and must keep running.
    const before = Date.now();
    const gui = await post("/commands", {
      command: "firefox-esr https://copilotkit.ai >/dev/null 2>&1 &",
    });
    assert.equal(gui.status, "succeeded", JSON.stringify(gui));
    assert.ok(Date.now() - before < 15000, "the GUI app held the command open");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(
      (await post("/commands", { command: "pgrep -x firefox-esr" })).status,
      "succeeded",
    );
    // Typed input reaches a focused terminal window and runs there.
    const typeIntoTerminal = async (file: string) => {
      await post("/commands", { command: "xfce4-terminal >/dev/null 2>&1 & sleep 3" });
      await act({ action: "type", text: `touch /workspace/${file}` });
      await act({ action: "key", text: "Return" });
      await act({ action: "key", text: "ctrl+shift+q" });
      const created = await post("/commands", { command: `test -e /workspace/${file}` });
      assert.equal(created.status, "succeeded", `typed input did not run: ${file}`);
    };
    // Input and screenshots on the freshly created box.
    await act({ action: "screenshot" });
    await act({ action: "left_click", coordinate: [640, 400] });
    await typeIntoTerminal("typed-fresh");
    const desktop = await call("/desktop");
    assert.match(desktop.url, /^https:\/\/6080-[^/]+\/vnc\.html\?.*password=/);
    assert.ok(!desktop.url.includes(apiKey ?? "-"));
    assert.equal((await call("/desktop")).url, desktop.url);
    assert.equal((await fetch(desktop.url)).status, 200);
    // Another process (e.g. a restarted API) cannot reuse that password, so it restarts
    // the stream; the first process then notices its cached URL went stale and never
    // returns it, restarting the stream with a password of its own.
    const other = await new ComputerService(db, config).desktopUrl(owner);
    assert.notEqual(other.url, desktop.url);
    const current = await call("/desktop");
    assert.notEqual(current.url, desktop.url);
    assert.notEqual(current.url, other.url);
    assert.equal((await call("/desktop")).url, current.url);
    assert.equal((await fetch(current.url)).status, 200);
    // A runaway writer is stopped before its temporary output fills the disk.
    const runaway = await post("/commands", { command: "yes" });
    assert.match(runaway.stderr, /Output exceeded the limit/);
    assert.equal(runaway.truncated, true);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    // Close to the 10 MB import limit: about 14 MB of JSON crosses the network on stdin.
    const { randomBytes } = await import("node:crypto");
    await pdf.attach(randomBytes(9.5 * 1024 * 1024), "noise.bin", {
      mimeType: "application/octet-stream",
    });
    const original = await server.files.import(owner, "smoke.pdf", await pdf.save(), "Smoke test");
    const importing = Date.now();
    await post("/files/import", { fileId: original.id, path: "/workspace/source.pdf" });
    console.log(`imported ${(await pdf.save()).length} byte PDF in ${Date.now() - importing} ms`);
    await post("/commands", { command: "cp source.pdf output.pdf" });
    const exported = await post("/files/export", { path: "/workspace/output.pdf" });
    assert.deepEqual(
      await server.files.bytes(owner, exported.id),
      await server.files.bytes(owner, original.id),
    );
    // The inner 30 second timeout reports exit 124 and leaves the computer running.
    const slow = await post("/commands", { command: "sleep 40" });
    assert.equal(slow.status, "timed_out");
    assert.equal(slow.exitCode, 124);
    assert.equal((await call("")).status, "running");
    assert.equal((await post("/stop")).status, "stopped");
    assert.equal((await post("/start")).status, "running");
    assert.equal(
      (await post("/files/read", { path: "/workspace/receipt.txt" })).text,
      "persisted from bash\n",
    );
    // Stop ends processes: the desktop session is back, the old browser is not.
    assert.equal((await post("/commands", { command: "pgrep -x firefox-esr" })).status, "failed");
    assert.equal(
      (await post("/commands", { command: "pgrep -x xfce4-session" })).status,
      "succeeded",
    );
    // After a pause and cold resume the sandbox env has no DISPLAY; actions still work.
    await act({ action: "screenshot" });
    await act({ action: "scroll", coordinate: [640, 400], scroll_direction: "down" });
    await typeIntoTerminal("typed-resumed");
    const restarted = await call("/desktop");
    assert.equal((await fetch(restarted.url)).status, 200);
    const pending = server.computer.execute(owner, {
      command: "printf ready > /workspace/.smoke-running; sleep 30",
    });
    const [id] = await sandboxIds();
    const box = await Sandbox.connect(id, { apiKey });
    const deadline = Date.now() + 15000;
    while (true) {
      const probe = await box.commands
        .run("cat /workspace/.smoke-running", { user: "root" })
        .catch(() => undefined);
      if (probe?.stdout === "ready") break;
      assert.ok(Date.now() < deadline, "command process failed to begin");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await server.computer.stop(owner);
    assert.equal((await pending).status, "interrupted");
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
    // A stopped computer refuses desktop actions instead of resuming.
    const refused = await server.app.request("/api/computer/desktop/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "screenshot" }),
    });
    assert.equal(refused.status, 409);
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
    assert.ok(
      (await server.computer.snapshot(owner)).commands.some(
        (receipt) => receipt.id === command.id && receipt.status === "succeeded",
      ),
    );
  } finally {
    const ids = await sandboxIds();
    const killed = await Promise.all(ids.map((id) => Sandbox.kill(id, { apiKey })));
    await db.close();
    await rm(directory, { recursive: true, force: true });
    assert.ok(killed.every(Boolean), "smoke sandbox cleanup failed");
  }
});
