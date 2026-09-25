import {
  Bell,
  CheckCircle2,
  Clock,
  Fingerprint,
  List,
  LogOut,
  Settings,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { MASCOT_COLORS, MASCOT_STATUSES, useMascotState } from "./mascot-state";
import { MuseCat } from "./muse-cat";
import { PendingActionApprovals, SubagentsLivePanel } from "./subagent-live";
import { Button, colors, IconButton, s } from "./ui";
import { useWorkspace } from "./workspace";

export function AgentInspector({
  onClose,
  onLogout,
}: {
  onClose: () => void;
  onLogout?: () => void;
}) {
  const mascotState = useMascotState();
  const { workspace, open, navigate } = useWorkspace();
  const { data: agentData, mutate } = useAgentWorkspace();
  const [tab, setTab] = useState<"tasks" | "approvals" | "timeline" | "identity">("tasks");

  // Dynamic agent name from settings/database; fallback to "Muse"
  const agentName = agentData?.identity?.name?.trim() || "Muse";

  const [inputName, setInputName] = useState(agentName);
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    if (agentData?.identity?.name) {
      setInputName(agentData.identity.name);
    }
  }, [agentData?.identity?.name]);

  async function handleSaveName() {
    if (!inputName.trim()) return;
    setSavingName(true);
    setNameSaved(false);
    try {
      await mutate("/identity", {
        name: inputName.trim(),
        tone: agentData?.identity?.tone || "warm",
        avatar: agentData?.identity?.avatar || "sky",
        showChatUpdates: agentData?.identity?.showChatUpdates !== false,
      });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2500);
    } catch (e) {
      console.error(e);
    } finally {
      setSavingName(false);
    }
  }

  const pendingApprovals = (workspace.actions || []).filter((a) => a.status === "awaiting_review");
  const pending =
    pendingApprovals.length + (agentData?.notifications?.filter((n) => !n.read).length || 0);

  const tasks = [...(agentData?.tasks || [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  const runningSubagents = tasks.filter(
    (t) =>
      (t.input?.subagent === true || Boolean(t.input?.fanoutId) || t.kind === "agent") &&
      !["succeeded", "failed", "cancelled"].includes(t.status),
  );

  const activeStatus =
    runningSubagents.length > 0
      ? runningSubagents[0].title
      : workspace.actions.some((a) => a.status === "awaiting_review")
        ? "Action pending review"
        : "Ready";

  return (
    <View
      style={{
        width: 320,
        backgroundColor: "#FFFFFF",
        borderLeftWidth: 1,
        borderLeftColor: "#E5E7EB",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top Header: Settings, Notifications, Logout around the Cat + Close (X) */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingTop: 6,
          paddingBottom: 2,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <IconButton
            size={32}
            icon={Settings}
            label="Open Settings"
            onPress={() => navigate("settings")}
          />
          <View style={{ position: "relative" }}>
            <IconButton
              size={32}
              icon={Bell}
              label={`Notifications, ${pending} unread or pending`}
              onPress={() => open({ type: "notifications" })}
            />
            {pending > 0 && (
              <View
                pointerEvents="none"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  position: "absolute",
                  top: 5,
                  right: 7,
                  backgroundColor: colors.blueDark,
                }}
              />
            )}
          </View>
          {onLogout && <IconButton size={32} icon={LogOut} label="Log out" onPress={onLogout} />}
        </View>
        <IconButton size={32} icon={X} label="Close inspector" onPress={onClose} />
      </View>

      {/* Avatar & Agent Persona Banner (Moved up, Bigger Cat) */}
      <View
        style={{ alignItems: "center", paddingTop: 0, paddingBottom: 10, paddingHorizontal: 16 }}
      >
        <View
          style={{
            width: 124,
            height: 124,
            borderRadius: 62,
            backgroundColor: "#F3F4F6",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 6,
            borderWidth: 3,
            borderColor: "#E5E7EB",
            position: "relative",
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.08,
            shadowRadius: 8,
          }}
        >
          <MuseCat size={92} state={mascotState} />
          {/* Live Status indicator dot on avatar border */}
          <View
            style={{
              position: "absolute",
              bottom: 5,
              right: 11,
              width: 15,
              height: 15,
              borderRadius: 8,
              backgroundColor: MASCOT_COLORS[mascotState] ?? "#10B981",
              borderWidth: 2.5,
              borderColor: "#FFFFFF",
            }}
          />
        </View>
        {/* Dynamic Name from Settings */}
        <Text style={{ fontSize: 20, fontWeight: "700", color: colors.text }}>{agentName}</Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            backgroundColor: "rgba(240,237,247,0.85)",
            borderWidth: 1,
            borderColor: "rgba(220,215,231,0.8)",
            borderRadius: 999,
            paddingHorizontal: 10,
            paddingVertical: 3,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: MASCOT_COLORS[mascotState] ?? "#8b5cf6",
            }}
          />
          <Text
            numberOfLines={1}
            style={{
              fontSize: 10,
              fontWeight: "700",
              letterSpacing: 0.3,
              color: "#4a4458",
              textTransform: "uppercase",
              maxWidth: 200,
            }}
          >
            {MASCOT_STATUSES[mascotState]?.label || activeStatus}
          </Text>
        </View>
      </View>

      {/* Segmented Tab Bar */}
      <View
        style={{
          flexDirection: "row",
          backgroundColor: "#F3F4F6",
          borderRadius: 10,
          marginHorizontal: 16,
          padding: 3,
          marginBottom: 10,
        }}
      >
        <Pressable
          onPress={() => setTab("tasks")}
          {...({ title: "Tasks & Subagents" } as any)}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: tab === "tasks" ? "#FFFFFF" : "transparent",
            shadowColor: tab === "tasks" ? "#000" : "transparent",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.08,
            shadowRadius: 2,
            elevation: tab === "tasks" ? 2 : 0,
          }}
        >
          <List size={16} color={tab === "tasks" ? colors.blueDark : "#6B7280"} />
        </Pressable>

        <Pressable
          onPress={() => setTab("approvals")}
          {...({ title: "Action Approvals" } as any)}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: tab === "approvals" ? "#FFFFFF" : "transparent",
            position: "relative",
            shadowColor: tab === "approvals" ? "#000" : "transparent",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.08,
            shadowRadius: 2,
            elevation: tab === "approvals" ? 2 : 0,
          }}
        >
          <ShieldCheck size={16} color={tab === "approvals" ? "#D97706" : "#6B7280"} />
          {pendingApprovals.length > 0 && (
            <View
              style={{
                position: "absolute",
                top: 4,
                right: 14,
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: "#EF4444",
              }}
            />
          )}
        </Pressable>

        <Pressable
          onPress={() => setTab("timeline")}
          {...({ title: "Timeline / History" } as any)}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: tab === "timeline" ? "#FFFFFF" : "transparent",
            shadowColor: tab === "timeline" ? "#000" : "transparent",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.08,
            shadowRadius: 2,
            elevation: tab === "timeline" ? 2 : 0,
          }}
        >
          <Clock size={16} color={tab === "timeline" ? colors.blueDark : "#6B7280"} />
        </Pressable>

        <Pressable
          onPress={() => setTab("identity")}
          {...({ title: "Agent Settings" } as any)}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: tab === "identity" ? "#FFFFFF" : "transparent",
            shadowColor: tab === "identity" ? "#000" : "transparent",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.08,
            shadowRadius: 2,
            elevation: tab === "identity" ? 2 : 0,
          }}
        >
          <Fingerprint size={16} color={tab === "identity" ? colors.blueDark : "#6B7280"} />
        </Pressable>
      </View>

      {/* Tab Contents */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
      >
        {tab === "tasks" && (
          <View style={{ gap: 14 }}>
            {/* Live Subagents Panel */}
            <SubagentsLivePanel />

            {/* Today's Activity Feed */}
            <View style={{ marginTop: 4 }}>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "700",
                  color: colors.text,
                  marginBottom: 10,
                }}
              >
                Today
              </Text>
              {tasks.length === 0 ? (
                <Text style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic" }}>
                  No recent activities recorded today
                </Text>
              ) : (
                <View style={{ gap: 10 }}>
                  {tasks.slice(0, 10).map((task) => {
                    const isDone = ["succeeded", "finished", "completed"].includes(task.status);
                    const isFailed = task.status === "failed";
                    return (
                      <View
                        key={task.id}
                        style={{
                          flexDirection: "row",
                          gap: 10,
                          padding: 10,
                          backgroundColor: "#F9FAFB",
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: "#E5E7EB",
                        }}
                      >
                        <View style={{ paddingTop: 2 }}>
                          {isDone ? (
                            <CheckCircle2 size={16} color="#10B981" />
                          ) : isFailed ? (
                            <X size={16} color="#EF4444" />
                          ) : (
                            <Workflow size={16} color={colors.blueDark} />
                          )}
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text
                            style={{
                              fontSize: 13,
                              fontWeight: "600",
                              color: colors.text,
                            }}
                          >
                            {task.title}
                          </Text>
                          {Boolean(
                            task.question ||
                              task.plan?.find((s) => s.status === "running")?.title ||
                              task.result ||
                              task.prompt,
                          ) && (
                            <Text
                              numberOfLines={2}
                              style={{
                                fontSize: 11,
                                color: "#6B7280",
                              }}
                            >
                              {task.question ||
                                task.plan?.find((s) => s.status === "running")?.title ||
                                task.result ||
                                task.prompt}
                            </Text>
                          )}
                          <Text style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2 }}>
                            {new Date(task.updatedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </View>
        )}

        {tab === "approvals" && (
          <View style={{ gap: 10 }}>
            <PendingActionApprovals />
            {pendingApprovals.length === 0 && (
              <View style={{ paddingVertical: 20, alignItems: "center" }}>
                <ShieldCheck size={28} color="#10B981" />
                <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text, marginTop: 8 }}>
                  All clear!
                </Text>
                <Text style={{ fontSize: 12, color: "#6B7280", textAlign: "center", marginTop: 4 }}>
                  No actions currently waiting for your review.
                </Text>
              </View>
            )}
          </View>
        )}

        {tab === "timeline" && (
          <View style={{ gap: 10 }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>
              Activity History
            </Text>
            {tasks.map((task) => (
              <View
                key={task.id}
                style={{
                  padding: 8,
                  backgroundColor: "#F9FAFB",
                  borderRadius: 8,
                  gap: 3,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.text }}>
                  {task.title}
                </Text>
                <Text style={{ fontSize: 11, color: "#6B7280" }}>Status: {task.status}</Text>
              </View>
            ))}
          </View>
        )}

        {tab === "identity" && (
          <View style={{ gap: 12 }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>
              Agent Identity
            </Text>
            <View
              style={{
                backgroundColor: "#F9FAFB",
                padding: 12,
                borderRadius: 8,
                gap: 10,
                borderWidth: 1,
                borderColor: "#E5E7EB",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.text }}>
                Change Agent Name
              </Text>
              <View style={[s.row, { gap: 6 }]}>
                <TextInput
                  value={inputName}
                  onChangeText={setInputName}
                  placeholder="e.g. Muse"
                  placeholderTextColor="#9CA3AF"
                  style={
                    {
                      flex: 1,
                      backgroundColor: "#FFFFFF",
                      borderWidth: 1,
                      borderColor: "#D1D5DB",
                      borderRadius: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                      fontSize: 13,
                      color: colors.text,
                      outlineStyle: "none",
                    } as any
                  }
                />
                <Button
                  small
                  primary
                  busy={savingName}
                  disabled={!inputName.trim() || inputName.trim() === agentName}
                  onPress={() => void handleSaveName()}
                >
                  {nameSaved ? "Saved ✓" : "Save"}
                </Button>
              </View>
              <Text style={{ fontSize: 11, color: "#6B7280" }}>
                Updates the display name under the mascot and system prompt identity.
              </Text>
            </View>
            <Button small onPress={() => navigate("settings")}>
              Configure models & full settings
            </Button>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
