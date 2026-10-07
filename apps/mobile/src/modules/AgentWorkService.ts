/**
 * JS bridge to the Android foreground service for process-death recovery.
 *
 * On Android (with the native module linked via the `withAgentWorkService`
 * config plugin), the methods below call into `AgentWorkService.kt`, which
 * manages a foreground service and writes state to SharedPreferences. On
 * web and other platforms, the class falls back to `expo-secure-store` /
 * `localStorage` so the storage interface is always available.
 *
 * The foreground service keeps the JS process alive so the device-loop
 * heartbeat can continue after the app is backgrounded. If the OS still
 * kills the process, the saved state survives in SharedPreferences and is
 * read back by the headless recovery task (see `headless-recovery.ts`).
 *
 * This module imports `react-native` directly and must not be loaded in a
 * pure-Node test — the recovery logic it depends on (`recoverAgentState`)
 * lives in the RN-free `device-agent-loop.ts` and is unit-tested there.
 */

import * as SecureStore from "expo-secure-store";
import { NativeModules, Platform } from "react-native";
import type { AgentWorkState, AgentWorkStorage } from "../device-agent-loop";

export type { AgentWorkState };

/** Shape of the native module registered as `AgentWorkService` in Kotlin. */
interface NativeAgentWorkModule {
  startAgentService(taskId: string, leaseId: string, leaseUntil: string, title: string): void;
  stopAgentService(): void;
  updateLeaseUntil(leaseUntil: string): void;
  getSavedAgentState(): Promise<AgentWorkState | null>;
  clearSavedAgentState(): void;
}

const nativeModule: NativeAgentWorkModule | undefined = NativeModules.AgentWorkService as
  | NativeAgentWorkModule
  | undefined;

const STATE_KEY = "openmuse.agent_work_state";

/**
 * In-memory mirror of the persisted state.
 *
 * `updateLease` is called on every successful heartbeat; without this cache
 * it would have to read-modify-write through async storage on the hot path.
 * The native module writes SharedPreferences synchronously, so on Android the
 * cache is only a fast path — the authoritative copy is always native.
 */
let cachedState: AgentWorkState | null = null;

/** Persist `state` so it survives process death. Best-effort on the JS fallback path. */
async function persistState(state: AgentWorkState): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    return;
  }
  await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state));
}

async function readPersistedState(): Promise<AgentWorkState | null> {
  if (Platform.OS === "web") {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AgentWorkState;
    } catch {
      return null;
    }
  }
  const raw = await SecureStore.getItemAsync(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentWorkState;
  } catch {
    return null;
  }
}

async function clearPersistedState(): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.removeItem(STATE_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(STATE_KEY);
}

export class AgentWorkService implements AgentWorkStorage {
  /** Persist the active task and start the Android foreground service. */
  save(state: AgentWorkState): void {
    cachedState = { ...state };
    if (Platform.OS === "android" && nativeModule) {
      nativeModule.startAgentService(state.taskId, state.leaseId, state.leaseUntil, state.title);
    }
    // Fire-and-forget SecureStore fallback — persistence here is best-effort
    // recovery, not critical path data. On Android the native call above is
    // synchronous and authoritative.
    void persistState(state);
  }

  /** Update just the lease expiry in the saved state. */
  updateLease(leaseUntil: string): void {
    if (!cachedState) return;
    const updated = { ...cachedState, leaseUntil };
    cachedState = updated;
    if (Platform.OS === "android" && nativeModule) {
      nativeModule.updateLeaseUntil(leaseUntil);
      void persistState(updated);
    } else {
      void persistState(updated);
    }
  }

  /** Clear saved state and stop the foreground service. */
  clear(): void {
    cachedState = null;
    if (Platform.OS === "android" && nativeModule) {
      nativeModule.stopAgentService();
    }
    void clearPersistedState();
  }

  /**
   * Read persisted state — used on app launch to detect a killed process.
   * If the lease is still valid, the loop can be resumed.
   */
  static getSavedState = async (): Promise<AgentWorkState | null> => {
    if (Platform.OS === "android" && nativeModule) {
      return nativeModule.getSavedAgentState();
    }
    return readPersistedState();
  };

  /**
   * Clear persisted state without stopping the foreground service.
   *
   * Used by the headless recovery task after it has already let the service
   * die (the process was killed) and decided the lease is expired.
   */
  static clearSavedState = async (): Promise<void> => {
    cachedState = null;
    if (Platform.OS === "android" && nativeModule) {
      nativeModule.clearSavedAgentState();
    }
    await clearPersistedState();
  };
}
