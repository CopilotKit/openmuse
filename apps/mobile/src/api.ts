import { Platform } from "react-native";
import type { CardStatus, WorkboardCard, WorkboardStats } from "../../../packages/domain/src/agent";

function defaultApiUrl(): string {
  // On web the dashboard is served from the server itself: talk to the API on
  // the same host (port 8787) instead of a build-time localhost default, so
  // the login works from any hostname (tailnet IP, tunnel, etc.).
  if (Platform.OS === "web") {
    const w = (globalThis as any).window;
    const host = w?.location?.hostname as string | undefined;
    if (host) return `${w.location.protocol}//${host}:8787`;
  }
  return Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787";
}

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || defaultApiUrl()).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Wall-clock ceiling for a single request. Without one a hung socket keeps
 * the spinner (and any "refreshing" indicator) spinning forever and the error
 * only surfaces minutes later.
 */
const REQUEST_TIMEOUT_MS = 20000;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new ApiError(
      aborted
        ? "The request timed out \u2014 the server did not respond in time."
        : "Could not reach the server. Check your connection and try again.",
      aborted ? 408 : 0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the raw body instead of response.json() directly. Non-JSON bodies
 * (HTML proxy error pages, empty replies from an overloaded server) would
 * otherwise become an opaque "Unexpected token" SyntaxError and hide the
 * real status. Returns the parsed payload when possible, else undefined.
 */
async function readPayload(response: Response): Promise<{ payload: unknown; raw: string }> {
  const raw = await response.text();
  if (!raw.trim()) return { payload: undefined, raw };
  try {
    return { payload: JSON.parse(raw), raw };
  } catch {
    return { payload: undefined, raw };
  }
}

function statusDebug(status: number, raw: string): string {
  if (status === 502 || status === 503 || status === 504)
    return `The server is unreachable right now (${status}). Try again in a moment.`;
  if (raw) return raw.slice(0, 200);
  return `Request failed (${status})`;
}

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetchWithTimeout(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const { payload, raw } = await readPayload(response);
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && "error" in payload
          ? typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : statusDebug(response.status, raw)
          : statusDebug(response.status, raw);
      throw new ApiError(detail, response.status);
    }
    return payload as T;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}

export type SessionRole = "admin" | "user";
export interface SessionUser {
  username: string;
  role: SessionRole;
}
export async function createSession(
  username: string,
  password: string,
): Promise<{ token: string; mode: "sample" | "live"; username: string; role: SessionRole }> {
  const response = await fetchWithTimeout(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const { payload } = await readPayload(response);
  if (!response.ok)
    throw new ApiError(
      payload &&
        typeof payload === "object" &&
        typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : "Could not open your workspace.",
      response.status,
    );
  return payload as { token: string; mode: "sample" | "live"; username: string; role: SessionRole };
}
/** Public auth status for the sign-in screen hint (no auth required). */
export async function getAuthStatus(): Promise<{ usersConfigured: boolean; mode: string }> {
  const response = await fetchWithTimeout(`${API_URL}/api/auth/status`, { method: "GET" });
  if (!response.ok) throw new ApiError("Could not reach the server.", response.status);
  const { payload } = await readPayload(response);
  return payload as { usersConfigured: boolean; mode: string };
}

// ---------------------------------------------------------------------------
// Workboard (Kanban board of agent task cards).
// ---------------------------------------------------------------------------

/** The workboard.cards.list/stats binding shape: one call renders the board. */
export interface WorkboardBoard {
  cards: WorkboardCard[];
  stats: WorkboardStats;
}
export interface CreateWorkboardCardInput {
  title: string;
  description?: string;
  status?: CardStatus;
  priority?: WorkboardCard["priority"];
  labels?: string[];
  goalId?: string;
}
export interface UpdateWorkboardCardInput {
  title?: string;
  description?: string;
  priority?: WorkboardCard["priority"];
  labels?: string[];
  goalId?: string | null;
}
export interface WorkboardClient {
  board(): Promise<WorkboardBoard>;
  createCard(input: CreateWorkboardCardInput): Promise<WorkboardCard>;
  updateCard(id: string, input: UpdateWorkboardCardInput): Promise<WorkboardCard>;
  moveCard(id: string, input: { status: CardStatus; updatedAt: string }): Promise<WorkboardCard>;
  /** Task-mode dispatch: the owner tapping Dispatch IS the approval. */
  dispatch(id: string): Promise<WorkboardCard>;
}
export function createWorkboardClient(api: MuseApi): WorkboardClient {
  return {
    board: () => api.request<WorkboardBoard>("/api/workboard"),
    createCard: (input) => api.request<WorkboardCard>("/api/workboard/cards", input),
    updateCard: (id, input) =>
      api.request<WorkboardCard>(`/api/workboard/cards/${id}`, input, "PATCH"),
    moveCard: (id, input) => api.request<WorkboardCard>(`/api/workboard/cards/${id}/move`, input),
    dispatch: (id) =>
      api.request<WorkboardCard>(`/api/workboard/cards/${id}/dispatch`, { mode: "task" }),
  };
}
