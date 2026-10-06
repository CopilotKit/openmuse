/**
 * HTTP routes for the local-AI relay.
 *
 * `POST /localai/chat/completions` is an OpenAI-compatible endpoint that the
 * `local` provider in `tanstack-agent.ts` points at. When the device is
 * reachable it forwards the request body over that device's relay WebSocket
 * and streams the SSE response straight through. When the device is not
 * reachable it falls back to the operator-configured cloud provider.
 */
import { Hono } from "hono";
import type { DeviceInfo } from "../auth.ts";
import type { Config } from "../config.ts";
import type { LocalAiRelay } from "./localai-relay.ts";

export interface LocalAiRouteDeps {
  relay: LocalAiRelay;
  config: Config;
}

function fallbackModel(config: Config): string | null {
  const spec = config.chatModel ?? config.model;
  if (!spec) return null;
  // Strip the "provider/" prefix that adapter() expects.
  const [, , model] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  return model?.trim() ? model.trim() : spec;
}

/**
 * Start a fallback request to the configured cloud OpenAI provider.
 * Used when the device is not reachable.
 */
async function startFallback(
  originalBody: Record<string, unknown>,
  config: Config,
): Promise<Response> {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "No model is configured for fallback. Set OPENAI_API_KEY and a CHAT_MODEL or MODEL env var.",
          type: "server_error",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const fallbackModelName = fallbackModel(config);
  const body: Record<string, unknown> = {
    ...originalBody,
    ...(fallbackModelName ? { model: fallbackModelName } : {}),
  };

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function localAiRoutes(deps: LocalAiRouteDeps): Hono<{
  Variables: { owner: string; device: DeviceInfo };
}> {
  const app = new Hono<{
    Variables: { owner: string; device: DeviceInfo };
  }>();

  /**
   * OpenAI-compatible chat completions relay.
   *
   * The `local` provider in `tanstack-agent.ts` sets `X-Device-ID` as a
   * default header, so every request from that adapter carries the device it
   * is routing for. This route reads it, checks reachability, and either
   * forwards through the device's relay WebSocket or falls back to the cloud.
   */
  app.post("/localai/chat/completions", async (c) => {
    const deviceId = c.req.header("x-device-id") ?? c.get("device")?.deviceId ?? null;

    if (!deviceId) {
      return c.json(
        { error: "A device ID is required for local AI relay. Sign in with a device." },
        400,
      );
    }

    const body = (await c.req.json()) as Record<string, unknown>;
    const reachable = deps.relay.isReachable(deviceId);

    if (!reachable) {
      return startFallback(body, deps.config);
    }

    const abortController = new AbortController();
    const budgetMs = deps.config.localaiFallbackBudgetMs ?? 60_000;
    const fallbackTimer = setTimeout(() => {
      if (!abortController.signal.aborted) abortController.abort();
    }, budgetMs);

    // Extract meaty auth headers the adapter stamped on the request.
    const relayHeaders: Record<string, string> = {};
    for (const key of ["authorization", "x-ecosystem-app", "x-priority"]) {
      const value = c.req.header(key);
      if (value !== undefined) relayHeaders[key] = value;
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of deps.relay.forward(
            deviceId,
            body,
            relayHeaders,
            abortController.signal,
          )) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        } finally {
          clearTimeout(fallbackTimer);
        }
      },
      cancel() {
        clearTimeout(fallbackTimer);
        abortController.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  /** Health-check for the relay: reports which devices are connected. */
  app.get("/localai/relay/health", (c) =>
    c.json({
      connectedDevices: deps.relay.connectionCount(),
      enabled: deps.config.localaiRelayEnabled ?? false,
    }),
  );

  return app;
}
