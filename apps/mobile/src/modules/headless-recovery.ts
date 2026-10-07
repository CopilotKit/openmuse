/**
 * Headless JS task for process-death recovery.
 *
 * Registered via `AppRegistry.registerHeadlessTask("AgentWorkRecovery", …)`.
 * The native `AgentWorkHeadlessService` (Kotlin) starts this JS task when the
 * OS restarts the process after killing it.
 *
 * Flow:
 * 1. Read saved state from AgentWorkService (SharedPreferences bridge).
 * 2. recoverAgentState decides: resume | requeue | noop.
 * 3. On resume, rebuild a DeviceAgentLoop with the saved lease, restore the
 *    ActiveRun, and start the heartbeat — keeping the lease alive until the
 *    app returns to the foreground, at which point `useDeviceLoop` takes over.
 * 4. On requeue, clear saved state (the server already requeued the task).
 * 5. On noop, return immediately.
 *
 * The headless loop uses a no-op executor: it only needs to hold the lease,
 * not execute new work. If the lease survives the 2-minute headless timeout
 * and the app hasn't foregrounded, the server eventually requeues
 * and the next claim cycle picks it up normally.
 */

import * as SecureStore from "expo-secure-store";
import { AppRegistry } from "react-native";
import { MuseApi } from "../api";
import { DeviceAgentLoop, recoverAgentState } from "../device-agent-loop";
import { agentExecutor, type DeviceRunner, deviceTransport } from "../device-protocol";
import { AgentWorkService } from "./AgentWorkService";

/** Lease-window grace to cover UTC jitter between OS restart and JS startup. */
const LEASE_GRACE_MS = 60_000;

/** The headless task never executes agent work — only heartbeats. */
const noOpRunner: DeviceRunner = async () => "";

AppRegistry.registerHeadlessTask("AgentWorkRecovery", () => async () => {
  const saved = await AgentWorkService.getSavedState();
  if (!saved) return;

  const action = recoverAgentState(saved, Date.now(), LEASE_GRACE_MS);

  switch (action) {
    case "resume": {
      const token = await SecureStore.getItemAsync("session_token");
      if (!token) {
        void AgentWorkService.clearSavedState();
        return;
      }
      const api = new MuseApi(token);
      const loop = new DeviceAgentLoop(
        deviceTransport(api),
        agentExecutor(noOpRunner),
        undefined,
        undefined,
        new AgentWorkService(),
      );
      loop.restoreSavedState(saved);
      loop.start();
      return;
    }
    case "requeue":
      void AgentWorkService.clearSavedState();
      return;
    case "noop":
      return;
  }
});
