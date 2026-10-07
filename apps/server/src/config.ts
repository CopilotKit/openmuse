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
// Capture the full setup/activation funnel while preserving explicit SDK opt-outs
// and any deployment-specific sampling rate. Config loads before runtime imports.
process.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE ??= "1";

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
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  webSearchEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  computerProvider?: ComputerProvider;
  computerE2bTemplate?: string;
  e2bApiKey?: string;
  allowedOrigins: string[];
  trustProxy?: boolean;
}

export type ComputerProvider = "docker" | "e2b-desktop";

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

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

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;

export function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  return port;
}

export function parsePublicUrl(raw: string | undefined, port: number): string {
  const value = (raw ?? `http://localhost:${port}`).trim().replace(/\/+$/, "");
  if (!value) throw new Error("PUBLIC_API_URL must be a valid URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_API_URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("PUBLIC_API_URL must use http or https");
  // Downstream consumers concatenate this value as a base string
  // (Auth.sign does `${publicUrl}${path}?owner=...`, callback is
  // `${publicUrl}/api/google/callback`), so credentials, queries,
  // fragments, and subpaths would produce malformed links or leak secrets.
  if (parsed.username || parsed.password)
    throw new Error("PUBLIC_API_URL must not contain credentials");
  if (parsed.search || parsed.hash)
    throw new Error("PUBLIC_API_URL must not contain a query string or fragment");
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    throw new Error("PUBLIC_API_URL must not contain a subpath");
  return parsed.origin;
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? "http://localhost:8081,http://127.0.0.1:8081")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const origins: string[] = [];
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    const origin = parsed.origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export function isValidEncryptionKey(key: string): boolean {
  try {
    const bytes = Buffer.from(key, "base64");
    return bytes.length === 32 && bytes.toString("base64") === key;
  } catch {
    return false;
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
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const computerProvider = process.env.COMPUTER_PROVIDER?.trim() || "docker";
  if (computerProvider !== "docker" && computerProvider !== "e2b-desktop")
    throw new Error("COMPUTER_PROVIDER must be docker or e2b-desktop");
  const e2bApiKey = process.env.E2B_API_KEY?.trim();
  if (process.env.COMPUTER_ENABLED === "true" && computerProvider === "e2b-desktop") {
    if (!e2bApiKey)
      throw new Error("COMPUTER_PROVIDER=e2b-desktop requires a nonblank E2B_API_KEY");
    // Sandboxes are matched by metadata across the whole E2B team, and every default
    // install would otherwise derive the same deployment label from localhost:8787.
    if (!process.env.COMPUTER_DEPLOYMENT_ID?.trim())
      throw new Error(
        "COMPUTER_PROVIDER=e2b-desktop requires a unique COMPUTER_DEPLOYMENT_ID, e.g. from `openssl rand -hex 12`",
      );
  }
  const port = parsePort(process.env.PORT);
  const publicUrl = parsePublicUrl(process.env.PUBLIC_API_URL, port);
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
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: required("CPK_INTELLIGENCE_API_KEY", intelligenceKeyRequiredMessage),
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    webSearchEnabled: process.env.WEB_SEARCH_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    computerProvider,
    computerE2bTemplate: process.env.COMPUTER_E2B_TEMPLATE?.trim() || "desktop",
    e2bApiKey,
    allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
    // Only trust X-Forwarded-For/X-Real-IP when the deployment is known to sit
    // behind a proxy that sets them; otherwise a direct caller can spoof them.
    trustProxy: process.env.TRUST_PROXY === "true",
  };
  if (
    mode === "live" &&
    (!config.accessKey ||
      config.accessKey.length < 24 ||
      !config.encryptionKey ||
      !isValidEncryptionKey(config.encryptionKey))
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
