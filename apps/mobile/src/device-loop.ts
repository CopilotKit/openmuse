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
 *   on foreground. A task already in hand keeps running and keeps heartbeating,
 *   which is the documented continuation promise; only *new* claims wait for the
 *   app to come back.
 *
 * - **Nothing is auto-enabled.** The user turns the loop on. A phone that
 *   silently started claiming tasks the moment the app opened would be draining
 *   the queue for a user who never asked, and the board's whole premise is that
 *   work is delegated deliberately.
 */

import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import type { MuseApi } from "./api";
import {
  type AgentWorkState,
  DeviceAgentLoop,
  type LoopSnapshot,
  recoverAgentState,
} from "./device-agent-loop";
import { agentExecutor, type DeviceRunner, deviceTransport } from "./device-protocol";
import { LocalAiClient } from "./localai-client";
import { AgentWorkService } from "./modules/AgentWorkService";

export type { AgentRequester, DeviceRunner } from "./device-protocol";
export { agentExecutor, deviceTransport } from "./device-protocol";
export type { LoopSnapshot };

/** Grace window (ms) for a lease that may have lapsed between OS restart and JS startup. */
export const LEASE_GRACE_MS = 60_000;

/** Recovery banner state: checking → paused (user decides) → dismissed. */
export type RecoveryState =
  | { kind: "checking" }
  | { kind: "paused"; title: string }
  | { kind: "dismissed" };

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
  /** Recovery banner state: checking → paused/dismissed. */
  recovery: RecoveryState;
  /** Resume the recovered run shown in the banner. */
  resumeRecoveredRun: () => void;
  /** Dismiss the banner and clear saved state. */
  cancelRecoveredRun: () => void;
}

/**
 * A device work loop bound to this component's lifetime.
 *
 * The loop is created once per `api` and torn down on unmount, so a token change
 * (a fresh session) cannot leave a loop heartbeating on a lease held under the
 * previous one. That matters: the old lease would keep expiring and requeueing
 * work that the new session is also trying to run.
 *
 * The `AgentWorkService` storage adapter is injected so the loop can persist
 * its claim to SharedPreferences / SecureStore on every save, update the lease
 * on every heartbeat, and clear on finish — the mechanism the recovery banner
 * and headless task rely on.
 */
export function useDeviceLoop(api: MuseApi, runAgent: DeviceRunner): DeviceLoop {
  const loop = useMemo(
    () =>
      new DeviceAgentLoop(
        deviceTransport(api),
        agentExecutor(runAgent),
        undefined,
        undefined,
        new AgentWorkService(),
      ),
    [api, runAgent],
  );
  const relay = useMemo(() => new LocalAiClient({ token: api.token }), [api.token]);

  // Persist the session token so the headless recovery task can reconstruct
  // a transport when the OS restarts the process after a kill.
  useEffect(() => {
    void SecureStore.setItemAsync("session_token", api.token);
  }, [api.token]);

  // Recovery: check for a saved run left over from before a process kill.
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: "checking" });
  const savedRef = useRef<AgentWorkState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await AgentWorkService.getSavedState();
      if (cancelled) return;
      if (!saved) {
        setRecovery({ kind: "dismissed" });
        return;
      }
      const action = recoverAgentState(saved, Date.now(), LEASE_GRACE_MS);
      if (action === "resume") {
        savedRef.current = saved;
        setRecovery({ kind: "paused", title: saved.title });
      } else {
        void AgentWorkService.clearSavedState();
        setRecovery({ kind: "dismissed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resumeRecoveredRun = useCallback(() => {
    if (recovery.kind !== "paused" || savedRef.current === null) return;
    loop.restoreSavedState(savedRef.current);
    loop.start();
    void AgentWorkService.clearSavedState();
    setRecovery({ kind: "dismissed" });
  }, [loop, recovery]);

  const cancelRecoveredRun = useCallback(() => {
    void AgentWorkService.clearSavedState();
    savedRef.current = null;
    setRecovery({ kind: "dismissed" });
  }, []);

  useEffect(() => {
    return () => {
      void loop.shutdown();
      void relay.stop();
    };
  }, [loop, relay]);
  const subscribe = useCallback((listener: () => void) => loop.subscribe(listener), [loop]);
  const snapshot = useSyncExternalStore(subscribe, loop.getSnapshot, loop.getSnapshot);
  const start = useCallback(() => {
    loop.start();
    void relay.start();
  }, [loop, relay]);
  const stop = useCallback(() => {
    loop.stop();
    void relay.stop();
  }, [loop, relay]);
  const shutdown = useCallback(async () => {
    await loop.shutdown();
    await relay.stop();
  }, [loop, relay]);
  return {
    snapshot,
    start,
    stop,
    shutdown,
    recovery,
    resumeRecoveredRun,
    cancelRecoveredRun,
  };
}
