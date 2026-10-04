/**
 * The user-facing half of the device work loop.
 *
 * A card in Apps that turns the loop on, shows what this device is doing, and
 * reports why it cannot claim work. The wording matters as much as the wiring:
 * most of the states a phone can be in here are "you have to do something on
 * another machine", and saying so is more useful than a spinner.
 */

import { useAgent, useCopilotKit } from "@copilotkit/react-native/headless";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Text, View } from "react-native";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { runConversationTurn } from "./conversation-run";
import { isForeground, useDeviceLoop } from "./device-loop";
import { deviceStatusLine, visibleError } from "./device-work-copy";
import { Button, Card, Chip, colors, ErrorNotice, SectionHeading, s } from "./ui";
import { useWorkspace } from "./workspace";

export function DeviceWorkCard() {
  const { api } = useWorkspace();
  const [paired, setPaired] = useState<boolean>();
  const [pairingError, setPairingError] = useState("");

  // Execute the task on the same agent the chat screen uses, in its own thread.
  //
  // This is deliberately the SAME path a hand-delegated task takes, which is the
  // entire premise of a portable task: if a device-claimed task ran some other
  // way, "resumable on another device" would be a claim about a second, private
  // executor rather than about the agent itself. A dedicated thread id keeps
  // device work out of the user's conversation.
  const deviceThreadId = "device-work";
  const { agent, isReady } = useAgent({
    agentId: `openmuse-${deviceThreadId}`,
    runtimeAgentId: "default",
    threadId: deviceThreadId,
  });
  const { copilotkit } = useCopilotKit();

  const runAgent = useCallback(
    async (task: AgentTask, signal: AbortSignal): Promise<string> => {
      if (!isReady) throw new Error("The agent is not ready yet.");
      if (signal.aborted) throw new Error("This task moved to another device.");
      const text = task.prompt ?? task.title ?? task.id;
      agent.addMessage({ id: `device-${task.id}`, role: "user", content: text });
      const abort = () => void agent.abortRun?.();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await runConversationTurn(
          `openmuse-${deviceThreadId}`,
          () => copilotkit.runAgent({ agent }),
          (onError) => copilotkit.subscribe({ onError }),
        );
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted) throw new Error("This task moved to another device.");
      // The last assistant message is the task's result. Falling back to the
      // title keeps a silent run from reporting an empty success, which would
      // look like finished work on the board.
      const last = [...agent.messages].reverse().find((m) => m.role === "assistant");
      return typeof last?.content === "string" ? last.content : (task.title ?? "");
    },
    [agent, copilotkit, deviceThreadId, isReady],
  );

  const loop = useDeviceLoop(api, runAgent);
  const { snapshot } = loop;

  const refreshPairing = useCallback(async () => {
    try {
      const status = await api.request<{ paired: boolean }>("/api/agent/pairing");
      setPaired(status.paired);
      setPairingError("");
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void refreshPairing();
  }, [refreshPairing]);

  // Foreground-only claiming: stop taking NEW work in the background, but leave
  // a task in hand running and heartbeating. Restarting on the way back is what
  // makes the loop resume without the user doing anything.
  useEffect(() => {
    if (!snapshot.enabled) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (isForeground()) loop.start();
        return;
      }
      loop.stop();
    });
    return () => subscription.remove();
  }, [loop, snapshot.enabled]);

  const notice = visibleError(snapshot.error);
  return (
    <Card style={{ gap: 12 }}>
      <SectionHeading title="This device" />
      <Text style={s.muted}>
        When on, this device claims work it can run and keeps holding it while it works. Work
        needing send, delete or pay is never claimed here.
      </Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Chip>{paired === undefined ? "Checking…" : paired ? "Paired" : "Not paired"}</Chip>
        {snapshot.task && <Chip>Working</Chip>}
        {snapshot.enabled && !snapshot.task && <Chip>Looking for work</Chip>}
        {snapshot.completed > 0 && <Chip>{`${String(snapshot.completed)} done here`}</Chip>}
      </View>
      <Text style={s.small}>{deviceStatusLine(snapshot)}</Text>
      {snapshot.phase === "claiming" && <ActivityIndicator color={colors.blueDark} />}
      {notice && <ErrorNotice error={notice} />}
      <ErrorNotice error={pairingError} />
      <View style={[s.row, { gap: 8 }]}>
        <Button primary={!snapshot.enabled} onPress={loop.start} disabled={snapshot.enabled}>
          {snapshot.enabled ? "On" : "Use this device for work"}
        </Button>
        {snapshot.enabled && <Button onPress={loop.stop}>Pause</Button>}
      </View>
    </Card>
  );
}
