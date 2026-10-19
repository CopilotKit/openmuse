import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../server/src/app.ts";
import { computerIdentity } from "../server/src/computer.ts";
import type { Config } from "../server/src/config.ts";
import { createStore } from "../server/src/db.ts";

// Explicit opt-in script against real BoxCompute: a unique deployment, and every VM it
// creates is deleted afterwards. A BoxCompute console key has every scope it uses:
// sandbox:read, create, execute and delete, plus workspace:create unless
// BOXCOMPUTE_WORKSPACE_ID is set.
// Run: BOXCOMPUTE_API_KEY=... pnpm test:computer:boxcompute
const apiKey = process.env.BOXCOMPUTE_API_KEY?.trim();
const apiUrl = (process.env.BOXCOMPUTE_API_URL?.trim() || "https://api.boxcompute.ai").replace(
  /\/+$/,
  "",
);
const boxcompute = (path: string, init: RequestInit = {}) =>
  fetch(`${apiUrl}/api/v2${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, ...(init.headers as Record<string, string>) },
  });

test("real BoxCompute VM runs commands, opens Chrome, streams, acts, persists files and stops active work", {
  timeout: 900000,
  skip: !apiKey && "set BOXCOMPUTE_API_KEY to run the BoxCompute smoke test",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-boxcompute-smoke-"));
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
    computerProvider: "boxcompute",
    boxcomputeApiKey: apiKey,
    boxcomputeApiUrl: apiUrl,
    boxcomputeWorkspaceId: process.env.BOXCOMPUTE_WORKSPACE_ID?.trim() || undefined,
    computerDeploymentId: `smoke-${randomUUID()}`,
  };
  const server = await createApp(db, config);
  const owner = "local-user",
    labels = computerIdentity(config, owner).labels;
  const vmIds = async () => {
    const query = Object.entries(labels).map(
      ([key, value]) => `metadata=${encodeURIComponent(`${key}=${value}`)}`,
    );
    const response = await boxcompute(`/sandboxes?${query.join("&")}`);
    assert.ok(response.ok, `list: ${response.status}`);
    return ((await response.json()) as { sandboxes: { id: string }[] }).sandboxes.map(
      (vm) => vm.id,
    );
  };
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
    const creating = Date.now();
    const started = await post("/start");
    console.log(`created and started the VM and its desktop in ${Date.now() - creating} ms`);
    assert.equal(started.status, "running");
    assert.equal(started.provider, "boxcompute");
    assert.equal(started.network, "enabled");
    assert.equal(started.desktop, true);
    assert.equal((await vmIds()).length, 1);
    const command = await post("/commands", {
      command:
        "id -u; pwd; python3 --version; git --version; printf 'persisted from bash\\n' > receipt.txt",
    });
    assert.equal(command.status, "succeeded", JSON.stringify(command));
    assert.match(command.stdout, /^0\n\/workspace\nPython 3\./);
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
    // Typed input reaches a focused page: a local page posts every keystroke back
    // to a tiny server, which appends it to a file in /workspace.
    await post("/files/write", {
      path: "/workspace/typing.py",
      text: [
        "import http.server, pathlib",
        "PAGE = b'<input autofocus oninput=\"fetch(`/k?`+encodeURIComponent(this.value))\">'",
        "class H(http.server.BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        "        if self.path.startswith('/k?'):",
        "            from urllib.parse import unquote",
        "            pathlib.Path('/workspace/typed.txt').write_text(unquote(self.path[3:]))",
        "        self.send_response(200); self.end_headers(); self.wfile.write(PAGE)",
        "    def log_message(self, *a): pass",
        "http.server.HTTPServer(('127.0.0.1', 8765), H).serve_forever()",
      ].join("\n"),
    });
    await post("/commands", { command: "python3 /workspace/typing.py >/dev/null 2>&1 &" });
    // A backgrounded GUI app must not hold the command open, and must keep running.
    const before = Date.now();
    const gui = await post("/commands", {
      command: "chrome http://127.0.0.1:8765 >/dev/null 2>&1 &",
    });
    assert.equal(gui.status, "succeeded", JSON.stringify(gui));
    assert.ok(Date.now() - before < 15000, "the GUI app held the command open");
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(
      (await post("/commands", { command: "pgrep -f chrome-for-testing >/dev/null" })).status,
      "succeeded",
    );
    const typeIntoPage = async (text: string) => {
      await act({ action: "left_click", coordinate: [640, 140] });
      await act({ action: "key", text: "ctrl+a BackSpace" });
      await act({ action: "type", text });
      const typed = await post("/files/read", { path: "/workspace/typed.txt" });
      assert.equal(typed.text, text, "typed input did not reach the page");
    };
    // Input and screenshots on the freshly created VM.
    await act({ action: "screenshot" });
    await typeIntoPage("typed fresh 123");
    const desktop = await call("/desktop");
    assert.match(desktop.url, /^https:\/\/[0-9a-f]{32}\./);
    assert.ok(!desktop.url.includes(apiKey ?? "-"));
    assert.equal(
      (await call("/desktop")).url,
      desktop.url,
      "a second request returns the same link",
    );
    const page = await fetch(desktop.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors \*/);
    assert.equal((await fetch(new URL("/viewer.js", desktop.url))).status, 200);
    // A runaway writer is stopped before its temporary output fills the disk.
    const runaway = await post("/commands", { command: "yes" });
    assert.match(runaway.stderr, /Output exceeded the limit/);
    assert.equal(runaway.truncated, true);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    // Close to the 10 MB import limit: larger than one BoxCompute file request.
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
    assert.equal(
      (await post("/commands", { command: "ls -a /workspace | grep -c openmuse-" })).stdout.trim(),
      "0",
    );
    // The inner 30 second timeout reports exit 124 and leaves the computer running.
    const slow = await post("/commands", { command: "sleep 40" });
    assert.equal(slow.status, "timed_out");
    assert.equal(slow.exitCode, 124);
    assert.equal((await call("")).status, "running");
    assert.equal((await post("/stop")).status, "stopped");
    const resuming = Date.now();
    assert.equal((await post("/start")).status, "running");
    console.log(`resumed the VM and its desktop in ${Date.now() - resuming} ms`);
    assert.equal(
      (await post("/files/read", { path: "/workspace/receipt.txt" })).text,
      "persisted from bash\n",
    );
    // Stop ends processes: the old browser and server are gone, the desktop is back.
    assert.equal(
      (await post("/commands", { command: "pgrep -f chrome-for-testing" })).status,
      "failed",
    );
    await act({ action: "screenshot" });
    await post("/commands", {
      command:
        "python3 /workspace/typing.py >/dev/null 2>&1 & chrome http://127.0.0.1:8765 >/dev/null 2>&1 & sleep 6",
    });
    await act({ action: "scroll", coordinate: [640, 400], scroll_direction: "down" });
    await typeIntoPage("typed resumed");
    assert.equal((await fetch((await call("/desktop")).url)).status, 200);
    const pending = server.computer.execute(owner, {
      command: "printf ready > /workspace/.smoke-running; sleep 25",
    });
    const deadline = Date.now() + 20000;
    while (true) {
      const probe = await server.computer
        .read(owner, "/workspace/.smoke-running")
        .catch(() => undefined);
      if (probe?.text === "ready") break;
      assert.ok(Date.now() < deadline, "command process failed to begin");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await server.computer.stop(owner).catch(() => {});
    assert.equal((await pending).status === "succeeded", false);
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
    // A stopped computer refuses commands and desktop actions instead of resuming.
    const refused = await server.app.request("/api/computer/desktop/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "screenshot" }),
    });
    assert.equal(refused.status, 409);
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
  } finally {
    const ids = await vmIds();
    const deleted = await Promise.all(
      ids.map(async (id) => (await boxcompute(`/sandboxes/${id}`, { method: "DELETE" })).ok),
    );
    await db.close();
    await rm(directory, { recursive: true, force: true });
    assert.ok(deleted.every(Boolean), "smoke VM cleanup failed");
  }
});
