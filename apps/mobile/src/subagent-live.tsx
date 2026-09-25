import {
  ArrowRight,
  CalendarDays,
  Check,
  Mail,
  MessageSquare,
  Pause,
  Play,
  Send,
  ShieldAlert,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { ActionProposal } from "../../../packages/domain/src";
import { useAgentWorkspace } from "./agent-workspace";
import { Button, Card, colors, ErrorNotice, relativeDate, s } from "./ui";
import { useWorkspace } from "./workspace";

export const SUBAGENT_ANIMALS: Record<string, string> = {
  Turtle: "🐢",
  Falcon: "🦅",
  Otter: "🦦",
  Beaver: "🦫",
  Fox: "🦊",
  Cheetah: "🐆",
  Owl: "🦉",
  Badger: "🦡",
  Panda: "🐼",
  Dolphin: "🐬",
  Koala: "🐨",
  Hawk: "🦅",
  Wolf: "🐺",
  Lynx: "🐱",
  Raven: "🐦‍⬛",
  Tiger: "🐯",
  Bear: "🐻",
  Eagle: "🦅",
};

export function parseSubagentInfo(
  title: string,
  id: string,
): { animal: string; topic: string; emoji: string } {
  const parts = title.split(" - ");
  if (parts.length >= 2) {
    const candidate = parts[0].trim();
    if (SUBAGENT_ANIMALS[candidate]) {
      return {
        animal: candidate,
        topic: parts.slice(1).join(" - ").trim(),
        emoji: SUBAGENT_ANIMALS[candidate],
      };
    }
  }
  const names = Object.keys(SUBAGENT_ANIMALS);
  let hash = 0;
  const key = id || title;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const animal = names[Math.abs(hash) % names.length];
  return {
    animal,
    topic: title || "Specialized Task",
    emoji: SUBAGENT_ANIMALS[animal] || "🤖",
  };
}

export function PendingActionApprovals() {
  const { workspace, api, refresh, open } = useWorkspace();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const pending = (workspace?.actions || []).filter((a) => a.status === "awaiting_review");
  if (!pending.length) return null;

  async function decide(action: ActionProposal, decision: "approve" | "deny") {
    setBusyId(action.id);
    setError("");
    try {
      await api.request(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <View style={{ gap: 8, marginVertical: 6 }}>
      <ErrorNotice error={error} />
      {pending.map((action) => {
        const d = (action.data || {}) as Record<string, any>;
        const isEmail = action.kind === "email.send";
        const isCalendar = action.kind.startsWith("calendar.");
        const isBusy = busyId === action.id;

        return (
          <Card
            key={action.id}
            style={{
              backgroundColor: "#FFF9F2",
              borderColor: "#E59E44",
              borderWidth: 1.5,
              padding: 15,
              borderRadius: 14,
              gap: 10,
            }}
          >
            <View style={s.between}>
              <View style={[s.row, { gap: 8, flex: 1 }]}>
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: "#FDF0DF",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {isEmail ? (
                    <Mail size={16} color="#B76500" />
                  ) : isCalendar ? (
                    <CalendarDays size={16} color="#B76500" />
                  ) : (
                    <ShieldAlert size={16} color="#B76500" />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.heading, { fontSize: 15, color: "#7B4300" }]}>
                    Approval Required: {action.title}
                  </Text>
                  <Text style={[s.small, { color: "#9E5B0E" }]}>
                    Safety policy: real-world actions require your approval before sending.
                  </Text>
                </View>
              </View>
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 10,
                  backgroundColor: "#FFE8CC",
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#B76500" }}>
                  NEEDS REVIEW
                </Text>
              </View>
            </View>

            {/* Details Box */}
            <View
              style={{
                backgroundColor: "#FFFFFF",
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#F0D3B0",
                gap: 4,
              }}
            >
              {isEmail && (
                <>
                  {Boolean(d.to) && (
                    <Text style={[s.small, { color: colors.text }]}>
                      <Text style={{ fontWeight: "700" }}>To: </Text>
                      {String(d.to)}
                    </Text>
                  )}
                  {Boolean(d.bcc) && (
                    <Text style={[s.small, { color: colors.text }]}>
                      <Text style={{ fontWeight: "700" }}>Bcc: </Text>
                      {String(d.bcc)}
                    </Text>
                  )}
                  {Boolean(d.subject) && (
                    <Text style={[s.small, { color: colors.text }]}>
                      <Text style={{ fontWeight: "700" }}>Subject: </Text>
                      {String(d.subject)}
                    </Text>
                  )}
                  {Boolean(d.body) && (
                    <Text
                      numberOfLines={3}
                      style={[s.small, { color: colors.muted, marginTop: 4 }]}
                    >
                      {String(d.body).slice(0, 220)}...
                    </Text>
                  )}
                </>
              )}
              {isCalendar && (
                <>
                  <Text style={[s.small, { color: colors.text }]}>
                    <Text style={{ fontWeight: "700" }}>Event: </Text>
                    {String(d.title || d.summary || action.title)}
                  </Text>
                  {Boolean(d.start) && (
                    <Text style={[s.small, { color: colors.muted }]}>
                      <Text style={{ fontWeight: "700" }}>When: </Text>
                      {String(d.start)}
                    </Text>
                  )}
                </>
              )}
            </View>

            {/* Action Buttons */}
            <View style={[s.row, { gap: 8, flexWrap: "wrap", marginTop: 2 }]}>
              <Button
                small
                primary
                icon={Check}
                busy={isBusy}
                onPress={() => void decide(action, "approve")}
              >
                Approve & Send
              </Button>
              <Button
                small
                danger
                icon={X}
                busy={isBusy}
                onPress={() => void decide(action, "deny")}
              >
                Reject
              </Button>
              <Button
                small
                icon={ArrowRight}
                onPress={() => open({ type: "review", action })}
                style={{ marginLeft: "auto" }}
              >
                Inspect
              </Button>
            </View>
          </Card>
        );
      })}
    </View>
  );
}

export function SubagentsLivePanel() {
  const { data, mutate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openReplyId, setOpenReplyId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const tasks = data?.tasks || [];
  const subagents = tasks
    .filter((task) => {
      const isSubagent =
        task.input?.subagent === true ||
        Boolean(task.input?.fanoutId) ||
        (task.kind === "agent" && !["succeeded", "failed", "cancelled"].includes(task.status));
      if (!isSubagent) return false;
      const isActive = !["succeeded", "failed", "cancelled"].includes(task.status);
      if (isActive) return true;
      // Show recently finished subagents (within last 15 minutes)
      const diffMs = Date.now() - new Date(task.updatedAt).getTime();
      return diffMs < 15 * 60 * 1000;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <>
      <PendingActionApprovals />
      {Boolean(subagents.length) && (
        <View style={{ gap: 10, marginVertical: 6 }}>
          <ErrorNotice error={error} />
          {subagents.map((task) => {
            const { animal, topic, emoji } = parseSubagentInfo(task.title, task.id);
            const isRunning =
              task.status === "running" || task.status === "queued" || task.status === "scheduled";
            const isPaused = task.status === "paused";
            const isWaitingInput = task.status === "waiting_input";
            const isWaitingApproval = task.status === "waiting_approval";
            const isSuccess = task.status === "succeeded";
            const isFailed = task.status === "failed";
            const isBusy = busyId === task.id;
            const isReplying = openReplyId === task.id;

            // Current activity description
            let activityText = "";
            if (isWaitingInput) {
              activityText = task.question || "Needs clarification to proceed.";
            } else if (isWaitingApproval) {
              activityText = "Waiting for your review to execute an external action.";
            } else if (isPaused) {
              activityText = "Paused by you. Ready to resume or take new guidance.";
            } else if (isRunning) {
              const runningStep = task.plan?.find((s) => s.status === "running");
              if (runningStep) {
                activityText = `Step: ${runningStep.title}`;
              } else if (task.evidence?.length) {
                activityText = `Gathered ${task.evidence.length} sources · Continuing analysis...`;
              } else {
                activityText = task.prompt
                  ? task.prompt.slice(0, 160)
                  : "Processing autonomous task...";
              }
            } else if (isSuccess) {
              activityText = task.result ? task.result.slice(0, 180) : "Completed successfully.";
            } else if (isFailed) {
              activityText = task.error
                ? `Failed: ${task.error.slice(0, 140)}`
                : "Stopped with an error.";
            }

            return (
              <Card
                key={task.id}
                style={{
                  backgroundColor: isWaitingInput
                    ? colors.sky
                    : isPaused
                      ? colors.orange
                      : "#FFFFFF",
                  borderColor: isRunning
                    ? "#48B570"
                    : isWaitingInput
                      ? colors.blueDark
                      : colors.line,
                  borderWidth: isRunning || isWaitingInput ? 1.5 : 1,
                  padding: 15,
                  gap: 10,
                  borderRadius: 14,
                }}
              >
                {/* Header: Animal Mascot & Topic + Status Badge */}
                <View style={s.between}>
                  <View style={[s.row, { gap: 8, flex: 1 }]}>
                    <Text style={{ fontSize: 20 }}>{emoji}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.heading, { fontSize: 15 }]}>
                        {animal} - {topic}
                      </Text>
                      <Text style={[s.small, { color: colors.muted }]}>
                        Sub-Agent · Updated {relativeDate(task.updatedAt)}
                      </Text>
                    </View>
                  </View>

                  {/* Status Badge */}
                  <View
                    style={{
                      paddingHorizontal: 9,
                      paddingVertical: 4,
                      borderRadius: 12,
                      backgroundColor: isRunning
                        ? "#E8F8EE"
                        : isPaused
                          ? "#FFF4E5"
                          : isWaitingInput
                            ? "#E8F3FD"
                            : isSuccess
                              ? "#E8F8EE"
                              : "#FCE8E6",
                      borderWidth: 1,
                      borderColor: isRunning
                        ? "#8AD09C"
                        : isPaused
                          ? "#F8C68C"
                          : isWaitingInput
                            ? colors.blueDark
                            : isSuccess
                              ? "#8AD09C"
                              : colors.danger,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: "700",
                        color: isRunning
                          ? "#1E7E34"
                          : isPaused
                            ? "#B76500"
                            : isWaitingInput
                              ? colors.blueDark
                              : isSuccess
                                ? "#1E7E34"
                                : colors.danger,
                      }}
                    >
                      {isRunning
                        ? "● RUNNING"
                        : isPaused
                          ? "⏸ PAUSED"
                          : isWaitingInput
                            ? "❓ INPUT NEEDED"
                            : isWaitingApproval
                              ? "📝 NEEDS REVIEW"
                              : isSuccess
                                ? "✓ COMPLETE"
                                : "✕ STOPPED"}
                    </Text>
                  </View>
                </View>

                {/* "What it is doing" */}
                <View
                  style={{
                    backgroundColor: isWaitingInput
                      ? "#FFFFFF"
                      : isPaused
                        ? "#FFFFFF88"
                        : colors.canvas,
                    padding: 10,
                    borderRadius: 8,
                    borderLeftWidth: 3,
                    borderLeftColor: isRunning
                      ? "#48B570"
                      : isWaitingInput
                        ? colors.blueDark
                        : isPaused
                          ? "#F5BA72"
                          : colors.muted,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "700",
                      color: colors.muted,
                      marginBottom: 2,
                    }}
                  >
                    {isWaitingInput
                      ? "QUESTION FROM SUBAGENT"
                      : isSuccess
                        ? "FINAL OUTCOME"
                        : "CURRENT ACTIVITY"}
                  </Text>
                  <Text
                    style={[s.text, { fontSize: 13, lineHeight: 19 }]}
                    numberOfLines={isReplying ? 6 : 3}
                  >
                    {activityText}
                  </Text>
                </View>

                {/* Inline Reply / Steering Input Box */}
                {isReplying && (
                  <View style={{ gap: 8, marginTop: 4 }}>
                    <TextInput
                      placeholder={`Reply or send instruction to ${animal}...`}
                      placeholderTextColor={colors.muted}
                      value={replyText[task.id] || ""}
                      onChangeText={(val) => setReplyText((prev) => ({ ...prev, [task.id]: val }))}
                      multiline
                      style={{
                        borderWidth: 1,
                        borderColor: colors.blueDark,
                        borderRadius: 8,
                        padding: 10,
                        fontSize: 13,
                        minHeight: 56,
                        backgroundColor: "#FFFFFF",
                        color: colors.text,
                      }}
                    />
                    <View style={[s.row, { justifyContent: "flex-end", gap: 8 }]}>
                      <Button small onPress={() => setOpenReplyId(null)}>
                        Cancel
                      </Button>
                      <Button
                        small
                        primary
                        icon={Send}
                        busy={isBusy}
                        onPress={() => void sendReply(task.id)}
                      >
                        Send to {animal}
                      </Button>
                    </View>
                  </View>
                )}

                {/* Action Buttons: Pause / Resume / Stop / Reply / Details */}
                <View style={[s.row, { gap: 8, flexWrap: "wrap", marginTop: 2 }]}>
                  {isRunning && (
                    <Button
                      small
                      icon={Pause}
                      busy={isBusy}
                      onPress={() => void act(task.id, "control", { action: "pause" })}
                    >
                      Pause
                    </Button>
                  )}

                  {isPaused && (
                    <Button
                      small
                      primary
                      icon={Play}
                      busy={isBusy}
                      onPress={() => void act(task.id, "control", { action: "resume" })}
                    >
                      Resume
                    </Button>
                  )}

                  {(isRunning || isPaused || isWaitingInput) && (
                    <Button
                      small
                      danger
                      icon={X}
                      busy={isBusy}
                      onPress={() => void act(task.id, "control", { action: "cancel" })}
                    >
                      Stop
                    </Button>
                  )}

                  <Button
                    small
                    primary={isWaitingInput && !isReplying}
                    icon={MessageSquare}
                    onPress={() => setOpenReplyId(isReplying ? null : task.id)}
                  >
                    {isReplying ? "Hide reply" : isWaitingInput ? "Reply now" : "Reply / Steer"}
                  </Button>

                  <Button
                    small
                    icon={ArrowRight}
                    onPress={() => open({ type: "task", taskId: task.id })}
                    style={{ marginLeft: "auto" }}
                  >
                    Details
                  </Button>
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </>
  );

  async function act(taskId: string, path: string, body: unknown) {
    setBusyId(taskId);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/${path}`, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function sendReply(taskId: string) {
    const text = replyText[taskId]?.trim();
    if (!text) return;
    setBusyId(taskId);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/reply`, { message: text });
      setReplyText((prev) => ({ ...prev, [taskId]: "" }));
      setOpenReplyId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }
}
