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
import { deviceId } from "./device";
import { isForeground, useDeviceLoop } from "./device-loop";
import {
  CODE_MAX_LENGTH,
  canSubmitCode,
  type DeviceSummary,
  deviceToApprove,
  normalizeCode,
  pairingView,
} from "./device-pairing";
import { deviceStatusLine, visibleError } from "./device-work-copy";
import { Button, Card, Chip, colors, ErrorNotice, Field, SectionHeading, s } from "./ui";
import { useWorkspace } from "./workspace";

export function DeviceWorkCard() {
  const { api } = useWorkspace();
  const [paired, setPaired] = useState<boolean>();
  const [attemptsRemaining, setAttemptsRemaining] = useState(0);
  const [pairingError, setPairingError] = useState("");
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selfId, setSelfId] = useState("");
  const [code, setCode] = useState("");
  const [minted, setMinted] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

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
      const status = await api.request<{
        paired: boolean;
        attemptsRemaining: number;
      }>("/api/agent/pairing");
      setPaired(status.paired);
      setAttemptsRemaining(status.attemptsRemaining);
      setPairingError("");
      const list = await api.request<DeviceSummary[]>("/api/agent/devices");
      setDevices(list);
      setSelfId(await deviceId());
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  /** Redeem a code typed from another device. */
  const redeem = useCallback(async () => {
    if (!canSubmitCode(code)) return;
    setPairingBusy(true);
    setPairingError("");
    try {
      await api.request("/api/agent/pairing/verify", { code: normalizeCode(code) });
      // The code is single-use, so clearing it stops a second submit from
      // spending another attempt on a challenge that has already been consumed.
      setCode("");
      await refreshPairing();
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
      await refreshPairing().catch(() => {});
    } finally {
      setPairingBusy(false);
    }
  }, [api, code, refreshPairing]);

  /** Mint a code for a device waiting to be approved. */
  const approve = useCallback(
    async (target: DeviceSummary) => {
      setPairingBusy(true);
      setPairingError("");
      try {
        const mintedFor = await api.request<{ code: string }>("/api/agent/pairing/request", {
          deviceId: target.id,
        });
        // Shown once, and deliberately not persisted: the server stores only a
        // hash, so this response is the sole chance to read it aloud.
        setMinted(`${target.name}: ${mintedFor.code}`);
      } catch (e) {
        setPairingError(e instanceof Error ? e.message : String(e));
      } finally {
        setPairingBusy(false);
      }
    },
    [api],
  );

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
  const view = paired === undefined ? null : pairingView({ paired, attemptsRemaining }, devices);
  const approval = deviceToApprove(selfId, devices);

  return (
    <Card style={{ gap: 12 }}>
      <SectionHeading title="This device" />
      <Text style={s.muted}>
        When on, this device claims work it can run and keeps holding it while it works. Work
        needing send, delete or pay is never claimed here.
      </Text>
      {view?.kind === "redeem" && (
        <>
          <Text style={s.small}>{view.detail}</Text>
          <Field
            label="Pairing code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={CODE_MAX_LENGTH}
            placeholder="123456"
          />
          <Button
            small
            primary
            busy={pairingBusy}
            disabled={!canSubmitCode(code)}
            onPress={() => void redeem()}
          >
            Pair this device
          </Button>
        </>
      )}
      {view?.kind === "approve" && (
        <>
          <Text style={s.small}>{view.detail}</Text>
          {minted ? (
            <Text style={[s.text, { fontVariant: ["tabular-nums"] }]}>{minted}</Text>
          ) : (
            approval && (
              <Button small busy={pairingBusy} onPress={() => void approve(approval)}>
                {`Create a code for ${approval.name}`}
              </Button>
            )
          )}
        </>
      )}
      {view?.kind === "paired" && <Text style={s.small}>{view.detail}</Text>}
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
      {/* Not offered while unpaired: claiming is behind the pairing gate, so the
          button's only possible outcome is an error on every press. */}
      {paired === true && (
        <View style={[s.row, { gap: 8 }]}>
          <Button primary={!snapshot.enabled} onPress={loop.start} disabled={snapshot.enabled}>
            {snapshot.enabled ? "On" : "Use this device for work"}
          </Button>
          {snapshot.enabled && <Button onPress={loop.stop}>Pause</Button>}
        </View>
      )}
    </Card>
  );
}
