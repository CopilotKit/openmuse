/**
 * The device work protocol as the client speaks it: paths, payloads, executor.
 *
 * Split out from `device-loop.ts` because that file imports React Native, and a
 * test that loads `react-native` cannot also load the server. Keeping the wire
 * format in a module with no native imports is what lets the end-to-end test
 * point this exact code at a real `createApp` instance and prove the client and
 * server actually agree — see `tests/device-loop-e2e.test.ts`.
 *
 * The paths and payload shapes below ARE the contract. A rename on the server
 * breaks a test rather than a phone in someone's hand.
 */

import type { AgentTask } from "../../../packages/domain/src/agent";
import type { ClaimResponse, DeviceWorkTransport, TaskExecutor } from "./device-agent-loop";

/**
 * The slice of `MuseApi` the transport needs.
 *
 * Narrower than `MuseApi` on purpose: a test can supply an implementation backed
 * by `app.request` instead of a live socket, so the protocol is exercised end to
 * end without binding a port.
 */
export interface AgentRequester {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
}

/** Build the transport that speaks the claim/heartbeat/report protocol. */
export function deviceTransport(api: AgentRequester): DeviceWorkTransport {
  return {
    claim: () => api.request<ClaimResponse>("/api/agent/device/claim", {}),
    heartbeat: (taskId: string, leaseId: string) =>
      api.request<{ ok: boolean; leaseUntil: string | null }>("/api/agent/device/heartbeat", {
        taskId,
        leaseId,
      }),
    report: (taskId: string, leaseId: string, outcome: "succeeded" | "failed", result: string) =>
      api.request("/api/agent/device/report", { taskId, leaseId, outcome, result }),
  };
}

/** Runs a claimed task on this device and returns its textual result. */
export type DeviceRunner = (task: AgentTask, signal: AbortSignal) => Promise<string>;

/**
 * Turn a device runner into a task executor.
 *
 * A runner that throws becomes a reported failure rather than a lost task — the
 * lease is still held, so the server must hear about it. The loop, not this
 * adapter, decides whether an *aborted* run is reportable.
 */
export function agentExecutor(runAgent: DeviceRunner): TaskExecutor {
  return async (task, signal) => {
    const result = await runAgent(
      { id: task.id, title: task.title ?? "", prompt: task.prompt ?? "" } as AgentTask,
      signal,
    );
    return { outcome: "succeeded", result };
  };
}
