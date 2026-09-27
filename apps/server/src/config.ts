import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
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
  /** Model used for interactive chat (ConversationAgent). Falls back to `model`. */
  chatModel?: string;
  /** Model used for complex durable tasks (task worker). Falls back to `model`, then `chatModel`. */
  taskModel?: string;
  /** Model used for simple task kinds (monitor, finance). Falls back to `chatModel`, then `model`. */
  simpleTaskModel?: string;
  /** Comma-separated tool name allowlist for chat (e.g. "delegate_task,agent_status,computer_*"). */
  chatToolAllowlist?: string[];
  /** Max tool-call iterations for interactive chat. Default: 6. */
  chatMaxSteps?: number;
  /** Max tool-call iterations for complex tasks. Default: 16. */
  taskMaxSteps?: number;
  /** Max tool-call iterations for simple tasks (monitor, finance). Default: 6. */
  simpleTaskMaxSteps?: number;
  /** SSE task-stream polling interval in milliseconds. Default: 2000. */
  streamPollIntervalMs?: number;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  /** OpenAI API format: "responses" (Responses API, default) or "chat-completions" (for local backends like Ollama/llama.cpp). */
  openaiApiFormat?: "responses" | "chat-completions";
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  allowedOrigins: string[];
}

export const intelligenceKeyRequiredMessage =
  "OpenMuse requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

export function assertApiDeploymentConfig(
  config: Config,
): asserts config is Config & { intelligenceApiKey: string } {
  required(
    "CPK_INTELLIGENCE_API_KEY",
    intelligenceKeyRequiredMessage,
    config.intelligenceApiKey ?? "",
  );
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
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
    chatModel: process.env.CHAT_MODEL,
    taskModel: process.env.TASK_MODEL,
    simpleTaskModel: process.env.SIMPLE_TASK_MODEL,
    chatToolAllowlist: process.env.CHAT_TOOL_ALLOWLIST
      ? process.env.CHAT_TOOL_ALLOWLIST.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    chatMaxSteps: process.env.CHAT_MAX_STEPS ? Number(process.env.CHAT_MAX_STEPS) : undefined,
    taskMaxSteps: process.env.TASK_MAX_STEPS ? Number(process.env.TASK_MAX_STEPS) : undefined,
    simpleTaskMaxSteps: process.env.SIMPLE_TASK_MAX_STEPS
      ? Number(process.env.SIMPLE_TASK_MAX_STEPS)
      : undefined,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    openaiApiFormat:
      // biome-ignore lint/suspicious/noUnnecessaryConditions: type assertion makes left side non-nullish
      (process.env.OPENAI_API_FORMAT as "responses" | "chat-completions") ?? "responses",
    intelligenceApiKey: required("CPK_INTELLIGENCE_API_KEY", intelligenceKeyRequiredMessage),
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: process.env.BROWSER_WORKER_URL,
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
    streamPollIntervalMs: process.env.STREAM_POLL_INTERVAL_MS
      ? Number(process.env.STREAM_POLL_INTERVAL_MS)
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
