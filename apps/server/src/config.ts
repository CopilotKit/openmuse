import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  /**
   * WhatsApp sidecar (Baileys) admin base URL and bearer token. The sidecar
   * is a separate localhost-only process (whatsapp-entry.ts); the API server
   * reaches it only over this URL. Both come from WHATSAPP_SIDECAR_URL /
   * WHATSAPP_SIDECAR_TOKEN. Absent = the WhatsApp connector's live operations
   * (pairing, send) are unavailable; metadata and rules still work.
   */
  whatsappSidecarUrl?: string;
  whatsappSidecarToken?: string;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  allowedOrigins: string[];
  /** Extra plugin discovery roots (operator-configured; see plugins/discovery.ts). */
  pluginRoots?: string[];
  /** AgentSkills root (SKILLS_ROOT; default ~/workspace/skills). */
  skillsRoot?: string;
  /**
   * AgentSkills allow-list (SKILLS_ALLOW, comma-separated). When non-empty,
   * only these skill names are indexed — deny-by-default for production.
   */
  skillsAllow?: string[];
  /**
   * Voice-note transcription (local whisper.cpp CLI). Both must be set for
   * POST /api/voice-notes to work; otherwise it answers 503. No network, no
   * API keys, no ports — transcription runs as a short-lived child process.
   */
  voiceTranscriberBin?: string;
  voiceTranscriberModel?: string;
  /** Max voice-note upload in bytes (default 10 MB). */
  voiceNoteMaxBytes?: number;
}

export function assertApiDeploymentConfig(config: Config): void {
  if (config.mode === "live" && !config.intelligenceApiKey?.trim()) {
    // The Intelligence key is a CopilotKit cloud add-on (durable Rich Threads),
    // not a security requirement. Live mode runs fine without it.
    console.warn(
      "[openmuse] CPK_INTELLIGENCE_API_KEY is not set; running without CopilotKit " +
        "cloud intelligence. Rich Threads are disabled; core agent features are unaffected. " +
        "Set the key to enable durable Rich Threads.",
    );
  }
}

export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: process.env.BROWSER_WORKER_URL,
    workerToken: process.env.WORKER_TOKEN,
    whatsappSidecarUrl: process.env.WHATSAPP_SIDECAR_URL,
    whatsappSidecarToken: process.env.WHATSAPP_SIDECAR_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8090,http://127.0.0.1:8090"
    ).split(","),
    pluginRoots: (process.env.PLUGIN_ROOTS ?? "")
      .split(",")
      .map((root) => root.trim())
      .filter(Boolean),
    skillsRoot: process.env.SKILLS_ROOT?.trim() || join(homedir(), "workspace", "skills"),
    skillsAllow: (process.env.SKILLS_ALLOW ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    voiceTranscriberBin: process.env.VOICE_TRANSCRIBER_BIN?.trim() || undefined,
    voiceTranscriberModel: process.env.VOICE_TRANSCRIBER_MODEL?.trim() || undefined,
    voiceNoteMaxBytes: process.env.VOICE_NOTE_MAX_BYTES
      ? Number(process.env.VOICE_NOTE_MAX_BYTES)
      : undefined,
  };
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
