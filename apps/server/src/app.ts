import { randomUUID } from "node:crypto";
import { MessageSchema } from "@ag-ui/core";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { emailDraftSchema, proposalSchema } from "../../../packages/domain/src/index.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, makeRuntime } from "./agent.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { ComputerService, type DockerRunner } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import type { Config } from "./config.ts";
import type { CredentialsService } from "./connectors/credentials/service.ts";
import type { EmailService } from "./connectors/email/service.ts";
import { whatsappInternalRoutes } from "./connectors/whatsapp/routes.ts";
import type { WhatsAppService } from "./connectors/whatsapp/service.ts";
import type { Store } from "./db.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import { loadPluginSystem, pluginSystemRoutes } from "./plugins/index.ts";
import {
  defaultSkillsAllow,
  defaultSkillsRoot,
  loadSkills,
  logSkillProblems,
} from "./skills/loader.ts";
import {
  assertNotLastEnabledAdmin,
  createUser,
  getUser,
  hashPassword,
  listUsers,
  normalizeUsername,
  revokeUserSessions,
  toPublic,
  type UserRole,
  validatePassword,
  verifyPassword,
} from "./users.ts";
import {
  ffmpegConvertToWav,
  processVoiceNote,
  VOICE_NOTE_MAX_BYTES,
  type VoiceNotePipeline,
  WhisperCppTranscriber,
} from "./voice-notes.ts";
import { workboardRoutes } from "./workboard/routes.ts";
import { WorkboardService } from "./workboard/service.ts";
import { WorkspaceService } from "./workspace.ts";

export async function createApp(
  db: Store,
  config: Config,
  options: {
    docker?: DockerRunner;
    voiceNotes?: Partial<VoiceNotePipeline>;
  } = {},
) {
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    browser = new BrowserService(db, config, auth, files),
    computer = new ComputerService(db, config, options.docker);
  // Voice notes: local whisper.cpp transcription. When the binary/model are
  // not configured the transcriber reports unavailable and POST
  // /api/voice-notes answers 503 instead of failing at startup.
  const voiceNotes: VoiceNotePipeline = {
    transcriber:
      options.voiceNotes?.transcriber ??
      (config.voiceTranscriberBin && config.voiceTranscriberModel
        ? new WhisperCppTranscriber(config.voiceTranscriberBin, config.voiceTranscriberModel)
        : {
            available: () => Promise.resolve(false),
            transcribe: (): Promise<never> => {
              throw new AppError("Voice transcription is not configured on this server", 503);
            },
          }),
    convertToWav: options.voiceNotes?.convertToWav ?? ffmpegConvertToWav,
  };
  // Capabilities come from openmuse.plugin.json manifests (see
  // docs/plugin-manifest.md), not hand-wiring. Invalid manifests are
  // reported at GET /api/plugins/errors and never crash startup.
  const plugins = await loadPluginSystem(db, config, { browser, files, google });
  // AgentSkills: validate the skills roots once at startup (fail-open —
  // invalid packs are skipped with a structured log, the server starts).
  // Per-run loads in engine/conversation.ts and engine/model.ts additionally
  // filter plugin skills by per-owner enablement.
  try {
    const startupSkills = await loadSkills({
      workspaceDir: config.skillsRoot ?? defaultSkillsRoot(),
      plugins,
      allowList: config.skillsAllow ?? defaultSkillsAllow(),
    });
    logSkillProblems(startupSkills.problems);
  } catch (error) {
    console.error({
      timestamp: new Date().toISOString(),
      context: { phase: "skills" },
      error: `skill startup scan failed (continuing without skills): ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const email = plugins.service<EmailService>("email");
  const credentials = plugins.service<CredentialsService>("credentials");
  const whatsapp = plugins.service<WhatsAppService>("whatsapp");
  const workspace = new WorkspaceService(db, config, files, google, email);
  // Assigned after the agent is constructed (the workboard needs it); the
  // execute closure below only runs on owner approval, long after startup.
  let workboard: WorkboardService | undefined;
  const actions = new ActionService(db, {
    execute: async (owner, input, connectionId, targetVersion) => {
      // A workboard dispatch is pure task-worker fan-out: no Google target
      // version, no account connection. The owner's approval IS the
      // authorization to spend the runs.
      if (input.kind === "workboard.dispatch" && workboard) {
        const card = await workboard.executeApprovedDispatch(owner, input.data);
        return input.data.mode === "fanout"
          ? `Fanned out to ${card.childCardIds.length} subagents; watch the child cards on the workboard`
          : "Dispatched to the task worker; the card moves as the task runs";
      }
      // An approved WhatsApp send executes through the sidecar. Like a
      // workboard dispatch it never reaches workspace.execute — the owner
      // approval plus the allow-list check inside executeApprovedSend IS
      // the authorization to send.
      if (input.kind === "whatsapp.send") {
        if (!whatsapp) throw new AppError("WhatsApp is unavailable", 503);
        return whatsapp.executeApprovedSend(owner, input.data, connectionId);
      }
      return workspace.execute(owner, input, connectionId, targetVersion);
    },
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
    emailConnected: (owner) => workspace.emailConnected(owner),
    emailConnection: (owner) => workspace.emailConnection(owner),
    // WhatsApp reviewed actions pin connection "wa:pairing"; the send is
    // gated on the socket actually being connected at both proposal and
    // execution time.
    whatsappConnected: async (owner) => (await whatsapp?.getStatus(owner))?.status === "connected",
    whatsappConnection: async (owner) => {
      const status = await whatsapp?.getStatus(owner);
      if (status?.status !== "connected") return null;
      return { id: "wa:pairing", account: status.jid ?? "WhatsApp" };
    },
  });
  const agent = new AgentService(
    db,
    config,
    workspace,
    files,
    actions,
    browser,
    computer,
    credentials,
    plugins,
  );
  workboard = new WorkboardService(db, agent);
  agent.workboard = workboard;
  agent.onTaskSettled = (owner, task) => workboard?.handleTaskSettled(owner, task);
  // WhatsApp reviewed actions and inbound routing. Bound here because both
  // the ActionService (proposer) and the AgentService (inbound router) only
  // exist after agent construction.
  whatsapp?.bindProposer((owner, input) => actions.propose(owner, input));
  whatsapp?.bindRouter({ createTask: (owner, input) => agent.createTask(owner, input) });
  const intelligence = config.intelligenceApiKey
    ? new CopilotKitIntelligence({ apiKey: config.intelligenceApiKey })
    : undefined;
  const runtime = makeRuntime(config, agent, auth, intelligence);
  const app = new Hono<{ Variables: { owner: string; username: string; role: UserRole } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large; PDFs must be 10 MB or smaller" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    // Fallback for AppError-shaped errors that fail instanceof (e.g. after
    // crossing a serialization boundary): the name and numeric status survive.
    if (
      error.name === "AppError" &&
      typeof (error as unknown as { status?: unknown }).status === "number"
    ) {
      const status = (error as unknown as { status: number }).status;
      const safeStatus = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503].includes(status)
        ? (status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503)
        : 502;
      return c.json({ error: error.message || "Request failed" }, safeStatus);
    }
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  // Public: lets the sign-in screen show the right hint before login.
  app.get("/api/auth/status", async (c) => {
    const users = await listUsers(db).catch(() => []);
    return c.json({ usersConfigured: users.length > 0, mode: config.mode });
  });
  app.post("/api/session", async (c) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
    const body = z
      .object({
        accessKey: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .parse(await c.req.json());
    const session = await auth.session(body);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google connection cancelled</h1><p>You can return to OpenMuse.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    await google.callback(state, code);
    return c.html(
      "<h1>Google is connected</h1><p>Return to OpenMuse and refresh your workspace.</p>",
    );
  });
  // Paths only an admin may touch. /api/users is enforced per-route (requireAdmin plus
  // the self-service password-change branch). Email account *reading* (folders,
  // messages) stays open so regular users keep mail; account management
  // (create/update/delete/test) is admin-only.
  const ADMIN_PATHS = [
    /^\/api\/health\/services$/,
    /^\/api\/credentials(\/|$)/,
    /^\/api\/provider-keys(\/|$)/,
    /^\/api\/google\/(connect|disconnect)$/,
  ];
  function adminOnlyPath(path: string, method: string): boolean {
    if (ADMIN_PATHS.some((re) => re.test(path))) return true;
    if (/^\/api\/email-accounts(\/|$)/.test(path)) {
      // Compose-box AI helpers are per-user conveniences, not account
      // administration — every signed-in user may use them.
      if (method === "POST" && (path.endsWith("/ai-reply") || path.endsWith("/fix-grammar")))
        return false;
      if (method === "POST" || method === "PUT" || method === "DELETE") return true;
      if (method === "POST" && /\/test$/.test(path)) return true;
      if (/\/test$/.test(path)) return true;
    }
    return false;
  }
  app.use("/api/*", async (c, next) => {
    const signedRoute =
      /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/.test(
        c.req.path,
      );
    if (signedRoute && c.req.query("signature")) {
      // Capability URLs carry their own HMAC; no dashboard role applies.
      c.set("owner", auth.verify(new URL(c.req.url)));
      c.set("username", "signed-link");
      c.set("role", "admin");
      await next();
      return;
    }
    const info = await auth.sessionInfo(c.req.header("authorization"));
    c.set("owner", info.owner);
    c.set("username", info.username);
    c.set("role", info.role);
    if (adminOnlyPath(c.req.path, c.req.method) && info.role !== "admin")
      throw new AppError("Admin access required", 403);
    await next();
  });
  const requireAdmin = (c: { get: (k: "role") => UserRole }) => {
    if (c.get("role") !== "admin") throw new AppError("Admin access required", 403);
  };
  app.post("/api/session/revoke", async (c) => {
    await auth.revoke(c.req.header("authorization"));
    return c.json({ ok: true });
  });

  // ---- Dashboard users (admin only; self-service password change allowed) ----
  app.get("/api/users", async (c) => {
    requireAdmin(c);
    return c.json({ users: (await listUsers(db)).map(toPublic) });
  });
  app.post("/api/users", async (c) => {
    requireAdmin(c);
    const body = z
      .object({
        username: z.string(),
        password: z.string(),
        role: z.enum(["admin", "user"]),
      })
      .parse(await c.req.json());
    const user = await createUser(db, body.username, body.password, body.role);
    return c.json({ user }, 201);
  });
  app.patch("/api/users/:username", async (c) => {
    const target = normalizeUsername(c.req.param("username"));
    const body = z
      .object({
        password: z.string().optional(),
        currentPassword: z.string().optional(),
        role: z.enum(["admin", "user"]).optional(),
        disabled: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const user = await getUser(db, target);
    if (!user) throw new AppError("User not found", 404);
    if (c.get("role") !== "admin") {
      // Regular users may only change their own password.
      if (
        target !== c.get("username") ||
        body.password === undefined ||
        body.role !== undefined ||
        body.disabled !== undefined
      )
        throw new AppError("Admin access required", 403);
      if (!body.currentPassword || !verifyPassword(body.currentPassword, user.passwordHash))
        throw new AppError("Current password is wrong", 401);
      validatePassword(body.password);
      user.passwordHash = hashPassword(body.password);
      await db.put("system", "users", user);
      return c.json({ user: toPublic(user) });
    }
    if (body.password !== undefined) {
      validatePassword(body.password);
      user.passwordHash = hashPassword(body.password);
    }
    if (body.role !== undefined && body.role !== user.role) {
      await assertNotLastEnabledAdmin(db, target);
      user.role = body.role;
    }
    if (body.disabled === true && !user.disabled) {
      await assertNotLastEnabledAdmin(db, target);
      user.disabled = true;
    } else if (body.disabled === false) {
      user.disabled = false;
    }
    await db.put("system", "users", user);
    await revokeUserSessions(db, target);
    return c.json({ user: toPublic(user) });
  });
  app.delete("/api/users/:username", async (c) => {
    requireAdmin(c);
    const target = normalizeUsername(c.req.param("username"));
    if (target === c.get("username")) throw new AppError("You cannot delete your own account", 409);
    const user = await getUser(db, target);
    if (!user) throw new AppError("User not found", 404);
    if (user.role === "admin") await assertNotLastEnabledAdmin(db, target);
    await db.remove("system", "users", target);
    await revokeUserSessions(db, target);
    return c.json({ ok: true });
  });
  // Voice notes: record in chat -> upload audio -> server-side transcription
  // -> transcript. Auth is enforced by the /api/* middleware (401 without a
  // session); the raw audio lives in a non-web-served temp dir and is deleted
  // after transcription.
  app.get("/api/voice-notes/status", async (c) =>
    c.json({ available: await voiceNotes.transcriber.available() }),
  );
  app.post("/api/voice-notes", async (c) => {
    const body = await c.req.parseBody();
    const file = body.audio;
    if (!(file instanceof File))
      throw new AppError("Attach the recording as the 'audio' form field", 400);
    return c.json(
      await processVoiceNote({
        dataDir: config.dataDir,
        file,
        maxBytes: config.voiceNoteMaxBytes ?? VOICE_NOTE_MAX_BYTES,
        pipeline: voiceNotes,
      }),
    );
  });
  // Service health for the Settings → Services tab. Probes each local
  // service over HTTP with a short timeout; never throws.
  type ServiceStatus = "up" | "down" | "not-configured";
  app.get("/api/health/services", async (c) => {
    async function probe(
      id: string,
      label: string,
      url: string | null,
      detail: string,
      headers?: Record<string, string>,
    ): Promise<{
      id: string;
      label: string;
      status: ServiceStatus;
      detail: string;
      latencyMs: number | null;
    }> {
      if (!url) return { id, label, status: "not-configured", detail, latencyMs: null };
      const started = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers });
        const latencyMs = Date.now() - started;
        if (res.ok)
          return { id, label, status: "up", detail: `${detail} · ${latencyMs}ms`, latencyMs };
        return { id, label, status: "down", detail: `${detail} · HTTP ${res.status}`, latencyMs };
      } catch (e) {
        return {
          id,
          label,
          status: "down",
          detail: `${detail} · ${e instanceof Error ? e.message : "unreachable"}`,
          latencyMs: null,
        };
      }
    }
    const services = await Promise.all([
      probe("api", "API", "http://127.0.0.1:8787/api/health", "openmuse-api"),
      probe("web", "Dashboard", "http://127.0.0.1:8090/", "openmuse-web"),
      probe(
        "browser-worker",
        "Browser worker",
        "http://127.0.0.1:8790/health",
        "openmuse-browser-worker",
      ),
      probe(
        "whatsapp-sidecar",
        "WhatsApp sidecar",
        config.whatsappSidecarUrl ? `${config.whatsappSidecarUrl}/admin/status` : null,
        "Baileys sidecar",
        config.whatsappSidecarToken
          ? { Authorization: `Bearer ${config.whatsappSidecarToken}` }
          : undefined,
      ),
    ]);
    return c.json({ services });
  });
  app.get("/api/workspace", async (c) => {
    const snapshot = await workspace.snapshot(c.get("owner"), c.req.query("q"));
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.route("/api/workboard", workboardRoutes(workboard));
  app.route("/api/computer", computerRoutes(computer, files));
  // Connector routes are mounted from plugin manifests (one folder + one
  // manifest per capability); the plugin system API is always available.
  for (const { path, routes } of plugins.mountedRoutes()) app.route(path, routes);
  // The WhatsApp sidecar calls back here (bearer-authenticated) with
  // stripped inbound messages. Not under /api so no owner session is
  // required; the sidecar token is the credential.
  if (whatsapp) app.route("/internal/whatsapp", whatsappInternalRoutes(whatsapp, config));
  app.route("/api/plugins", pluginSystemRoutes(plugins));
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (
      query.timeMin &&
      query.timeMax &&
      (Date.parse(query.timeMax) <= Date.parse(query.timeMin) ||
        Date.parse(query.timeMax) - Date.parse(query.timeMin) > 366 * 86400000)
    )
      throw new AppError("Choose a calendar range between one moment and 366 days", 422);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema.extend({ id: z.string().optional() }).parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    if (intelligence) {
      try {
        await intelligence.getOrCreateThread({
          threadId: main.threadId,
          userId: owner,
          agentId: "default",
        });
      } catch {
        throw new AppError(
          "Main conversation is unavailable. Check the Rich Threads connection and try again.",
          502,
        );
      }
    }
    return c.json({ threadId: main.threadId, existing: Boolean(intelligence) });
  });
  app.get("/api/conversation", async (c) => {
    const threadId = c.req.query("threadId") || "default";
    const key = threadId === "default" ? "default" : `side-${threadId}`;
    return c.json((await db.get(c.get("owner"), "conversations", key)) ?? { messages: [] });
  });
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const threadId = body.threadId || "default";
    const key = threadId === "default" ? "default" : `side-${threadId}`;
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: key, messages });
    return c.json({ ok: true });
  });
  app.delete("/api/chat/history", async (c) => {
    const owner = c.get("owner");
    // Local (non-rich-threads) conversation — main and all side chats.
    const allConversations = await db.list<{ id: string }>(owner, "conversations");
    for (const conv of allConversations) {
      await db.remove(owner, "conversations", conv.id);
    }
    // Sub-agent tasks and run events.
    const tasks = await db.list<{ id: string }>(owner, "tasks");
    for (const task of tasks) await db.remove(owner, "tasks", task.id);
    const runEvents = await db.list<{ id: string }>(owner, "run-events");
    for (const ev of runEvents) await db.remove(owner, "run-events", ev.id);
    // Notifications generated by tasks.
    const notifications = await db.list<{ id: string }>(owner, "notifications");
    for (const n of notifications) await db.remove(owner, "notifications", n.id);
    // Uploaded files: chat attachments and PDFs are stored here.
    const artifacts = await db.list<{ id: string }>(owner, "files");
    let filesDeleted = 0;
    for (const artifact of artifacts) {
      try {
        await files.delete(owner, artifact.id);
        filesDeleted += 1;
      } catch {
        // One bad file must not block the rest of the deletion.
      }
    }
    // Rich-threads conversations live in CopilotKit Intelligence; delete every
    // thread for this user so nothing survives server-side.
    let threadsDeleted = 0;
    let threadsError: string | undefined;
    if (intelligence) {
      try {
        let cursor: string | undefined;
        for (;;) {
          const listed = await intelligence.listThreads({
            userId: owner,
            agentId: "default",
            includeArchived: true,
            limit: 100,
            cursor,
          });
          for (const thread of listed.threads ?? []) {
            try {
              await intelligence.deleteThread({
                threadId: thread.id,
                userId: owner,
                agentId: "default",
              });
              threadsDeleted += 1;
            } catch {
              // One bad thread must not block the rest of the deletion.
            }
          }
          if (!listed.nextCursor) break;
          cursor = listed.nextCursor;
        }
      } catch {
        threadsError = "Some cloud threads could not be deleted; local history was still cleared.";
      }
    }
    // Drop the pinned main-thread id so the next visit starts a fresh thread.
    await db.remove(owner, "conversation-settings", "main");
    return c.json({ ok: true, filesDeleted, threadsDeleted, threadsError });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url), 201);
  });
  app.post("/api/browsers/restart", async (c) => {
    const owner = c.get("owner");
    const { closedSessions, clearedSessions } = await browser.restart(owner);
    const clearedCommands = await computer.clearCommands(owner);
    return c.json({ closedSessions, clearedSessions, clearedCommands });
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    await browser.input(c.get("owner"), c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  app.all("/api/copilotkit/*", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    const response = await runtime.fetch(c.req.raw);
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  app.get("/", (c) =>
    c.json({ name: "OpenMuse", app: "http://localhost:8090", health: "/api/health" }),
  );
  return {
    app,
    auth,
    files,
    actions,
    workspace,
    agent,
    workboard,
    computer,
    credentials,
    email,
    plugins,
  };
}
