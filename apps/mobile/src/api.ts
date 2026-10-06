import { Platform } from "react-native";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
      );
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
  /**
   * Like `request`, but streams the response body as Server-Sent Events.
   * Yields each parsed JSON object from a `data:` line until `[DONE]` or
   * the stream ends. Useful for streaming chat completions that include
   * `delta.tool_calls` and incremental text.
   */
  async *requestStream<T>(path: string, body?: unknown, method?: string): AsyncIterable<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method: method ?? "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Streaming not supported");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      let readDone = false;
      while (!readDone) {
        const { done, value } = await reader.read();
        readDone = done;
        if (done) {
          // Flush any remaining buffered SSE event.
          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              if (line.startsWith("data: ")) {
                const json = line.slice(6);
                if (json === "[DONE]") return;
                yield JSON.parse(json) as T;
              }
            }
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) {
              const json = line.slice(6);
              if (json === "[DONE]") return;
              yield JSON.parse(json) as T;
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export async function createSession(
  accessKey?: string,
  device?: { deviceId?: string; deviceName?: string },
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey, ...device }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not open your workspace.");
  return payload;
}
