/**
 * The device work loop, wired to the running app.
 *
 * `device-agent-loop.ts` holds the state machine and knows nothing about React;
 * this is the only place that knows about both `AppState` and the network. The
 * split is what lets the loop be tested with a fake clock instead of a
 * simulator.
 *
 * Two decisions worth stating, because both look like omissions:
 *
 * - **The loop runs in the foreground only.** `stop()` on background, `start()`
 * on foreground. A task already in hand keeps running and keeps heartbeating,
 * which is the documented continuation promise; only *new* claims wait for the
 * app to come back.
 *
 * - **Nothing is auto-enabled.** The user turns the loop on. A phone that
 *   silently started claiming tasks the moment the app opened would be draining
 *   the queue for a user who never asked, and the board's whole premise is that
 *   work is delegated deliberately.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import type { MuseApi } from "./api";
import { DeviceAgentLoop, type LoopSnapshot } from "./device-agent-loop";
import { agentExecutor, type DeviceRunner, deviceTransport } from "./device-protocol";

export type { AgentRequester, DeviceRunner } from "./device-protocol";
export { agentExecutor, deviceTransport } from "./device-protocol";
export type { LoopSnapshot };

/**
 * Is the app in a state where claiming new work is appropriate?
 *
 * Mirrors the visibility check the workspace poller in `agent-workspace.tsx`
 * already makes, including the web `document.hidden` case — Expo web runs in a
 * browser tab that reports `active` long after it is hidden.
 */
export function isForeground(): boolean {
  const state = AppState.currentState;
  if (state === "background" || state === "inactive") return false;
  if (Platform.OS === "web" && typeof document !== "undefined") return !document.hidden;
  return true;
}

export interface DeviceLoop {
  /** Current state: phase, the task in hand, and any notice worth showing. */
  snapshot: LoopSnapshot;
  /** Start claiming. Safe to call when already running. */
  start: () => void;
  /** Stop claiming. A task in hand continues. */
  stop: () => void;
  /** Stop and abandon the task in hand. */
  shutdown: () => Promise<void>;
}

/**
 * A device work loop bound to this component's lifetime.
 *
 * The loop is created once per `api` and torn down on unmount, so a token change
 * (a fresh session) cannot leave a loop heartbeating on a lease held under the
 * previous one. That matters: the old lease would keep expiring and requeueing
 * work that the new session is also trying to run.
 */
export function useDeviceLoop(api: MuseApi, runAgent: DeviceRunner): DeviceLoop {
  const loop = useMemo(
    () => new DeviceAgentLoop(deviceTransport(api), agentExecutor(runAgent)),
    [api, runAgent],
  );
  useEffect(() => {
    return () => {
      void loop.shutdown();
    };
  }, [loop]);
  const subscribe = useCallback((listener: () => void) => loop.subscribe(listener), [loop]);
  const snapshot = useSyncExternalStore(subscribe, loop.getSnapshot, loop.getSnapshot);
  return {
    snapshot,
    start: loop.start,
    stop: loop.stop,
    shutdown: loop.shutdown,
  };
}
