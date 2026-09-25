import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
  download: z
    .object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() })
    .nullish(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
  ) {}
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new AppError(
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        502,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: z.infer<typeof sessionSchema>) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    await this.db.put(owner, "browsers", session);
    return this.decorate(owner, session);
  }
  async create(owner: string, url: string) {
    const id = randomUUID();
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.put(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url);
  }
  private async openOwned(owner: string, id: string, url?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      const response = await this.request("/sessions", { id, url: target }, signal);
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string) {
    return this.serial(id, () => this.openOwned(owner, id, url));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (await this.request(`/sessions/${id}/read`, undefined, signal)).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async observe(owner: string, url: string, existingId?: string) {
    const id = existingId ?? (await this.create(owner, url)).id;
    return this.serial(id, async () => {
      if (existingId) await this.openOwned(owner, id, url);
      return { sessionId: id, ...(await this.readOwned(owner, id)) };
    });
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Persist the association before contacting the worker so failed/lost responses
    // and later chat turns keep using the same profile instead of exhausting its limit.
    const association =
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId)) ??
      (await this.db.insertIfAbsent(owner, "chat-browsers", {
        id: threadId,
        sessionId: randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId));
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      const opened = await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      const page = await this.readOwned(owner, id, signal);
      signal?.throwIfAborted();
      return {
        sessionId: id,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
        // A navigation preempted by a file download leaves the page blank;
        // surface the download so the agent never mistakes the previous
        // page's content for the requested URL.
        ...(opened.download ? { download: opened.download } : {}),
      };
    });
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(owner, await (await this.request(`/sessions/${id}/close`, {})).json(), id);
    });
  }
  /**
   * Full clean slate for the browser: close every owned session on the
   * worker (best-effort — a session that is already closed or unreachable
   * still gets its saved record removed), then drop the saved session
   * records and chat-browser associations.
   */
  async restart(owner: string) {
    const owned = await this.db.list<BrowserSession>(owner, "browsers");
    let closedSessions = 0;
    await Promise.all(
      owned.map((session) =>
        this.serial(session.id, async () => {
          try {
            await this.request(`/sessions/${session.id}/close`, {});
            closedSessions += 1;
          } catch {
            // Already closed, unknown to the worker, or the worker is down:
            // the saved record is still removed below.
          }
        }),
      ),
    );
    const clearedSessions = await this.db.removeAll(owner, "browsers");
    await this.db.removeAll(owner, "chat-browsers");
    return { closedSessions, clearedSessions };
  }
  /**
   * The owner's saved sessions, newest first, with live status from the
   * worker when it is reachable. Stored records are the fallback so the
   * agent can still inspect sessions while the worker is down.
   */
  async listSessions(owner: string) {
    const owned = await this.db.list<BrowserSession>(owner, "browsers");
    const liveById = new Map<string, z.infer<typeof sessionSchema>>();
    try {
      const response = await this.request("/sessions");
      const parsed = z.array(sessionSchema).safeParse(await response.json());
      if (parsed.success) for (const session of parsed.data) liveById.set(session.id, session);
    } catch {
      // Fall back to the stored records when the worker is unreachable.
    }
    return owned
      .map((session) => {
        const live = liveById.get(session.id);
        return {
          id: session.id,
          title: live?.title ?? session.title,
          url: live?.url ?? session.url,
          status: live?.status ?? session.status,
          updatedAt: live?.updatedAt ?? session.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.request(`/sessions/${id}/screenshot`);
  }
  async input(owner: string, id: string, value: unknown) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      // The dashboard agent's tool schema names the typing action "type";
      // the worker speaks "text". Translate at this choke point so every
      // caller (agent tools, tests, future routes) sends valid input.
      const record = value as Record<string, unknown> | null;
      const payload =
        record !== null && typeof record === "object" && record.type === "type"
          ? { ...record, type: "text" }
          : value;
      return this.save(
        owner,
        await (await this.request(`/sessions/${id}/input`, payload)).json(),
        id,
      );
    });
  }
  async snapshot(owner: string, id: string) {
    await this.get(owner, id);
    return (await this.request(`/sessions/${id}/snapshot`)).json();
  }
  /** Capture the session's current page as PNG bytes. */
  async screenshot(owner: string, id: string) {
    await this.get(owner, id);
    return new Uint8Array(await (await this.request(`/sessions/${id}/screenshot`)).arrayBuffer());
  }
  /**
   * Fill a login form in the session with a decrypted credential. The values
   * travel only over the authenticated worker channel; they are never logged
   * or returned to callers beyond the worker's receipt. The worker enforces
   * the expected domain independently before typing anything.
   */
  async fillLogin(
    owner: string,
    id: string,
    username: string,
    password: string,
    expectedDomain: string,
  ) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const payload = await (
        await this.request(`/sessions/${id}/fill`, { username, password, expectedDomain })
      ).json();
      const receipt = z.object({ filled: z.boolean(), submitted: z.boolean() }).parse(payload);
      await this.save(owner, payload, id);
      return receipt;
    });
  }
  async imports(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(await (await this.request(`/sessions/${id}/downloads`)).json());
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.request(
        `/sessions/${id}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }
}

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Keep a screenshot as durable evidence under DATA_DIR (0700 dir, 0600 file),
 * next to the app's other owner-scoped data. Chat never receives the image
 * bytes: the model gets a path plus size, which is what it can act on.
 */
export async function saveScreenshot(
  dataDir: string,
  owner: string,
  kind: "browser" | "desktop",
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    return {
      error: `The screenshot is ${Math.round(bytes.length / 1024 / 1024)} MB, over the ${Math.round(
        MAX_SCREENSHOT_BYTES / 1024 / 1024,
      )} MB evidence cap. Try again without fullPage.`,
    };
  }
  const ownerHash = createHash("sha256").update(owner).digest("hex").slice(0, 24);
  const directory = join(dataDir, "desktop-screenshots", ownerHash);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const capturedAt = new Date();
  const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
  const path = join(directory, `${stamp}-${kind}.png`);
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    kind: `${kind}-screenshot`,
    path,
    bytes: bytes.length,
    capturedAt: capturedAt.toISOString(),
    ...extra,
    note: "Saved on the OpenMuse host as a PNG file; the image itself is not attached to this conversation.",
  };
}
