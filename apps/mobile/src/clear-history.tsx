import { Trash2, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { CLEAR_HISTORY_CONFIRMATION, isDeleteConfirmed } from "./clear-history-confirm";
import { setMascotSource } from "./mascot-state";
import { Button, colors, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ClearHistorySheet({ onClose }: { onClose: () => void }) {
  const { api, notify } = useWorkspace();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmed = isDeleteConfirmed(confirmation);

  async function clearHistory() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    // Real work: chat history is being deleted right now.
    setMascotSource("maintenance", "clearing_history");
    try {
      const result = await api.request<{
        ok: boolean;
        filesDeleted: number;
        threadsDeleted: number;
        tasksDeleted?: number;
        threadsError?: string;
      }>("/api/chat/history", {}, "DELETE");
      const parts = ["Chat history, sub-agents and notifications cleared."];
      if (result.filesDeleted)
        parts.push(`${result.filesDeleted} file${result.filesDeleted === 1 ? "" : "s"} removed`);
      if (result.threadsDeleted) parts.push(`${result.threadsDeleted} cloud threads removed`);
      notify(result.threadsError ?? parts.join(" · "));
      if (Platform.OS === "web") {
        // A reload guarantees no stale thread, message, or attachment state survives.
        (globalThis as { location?: { reload(): void } }).location?.reload();
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMascotSource("maintenance", "idle");
      setBusy(false);
    }
  }

  return (
    <Sheet title="Clear chat history" subtitle="This cannot be undone" onClose={onClose}>
      <View style={{ gap: 14 }}>
        <View style={[s.row, { gap: 10 }]}>
          <TriangleAlert size={20} color={colors.danger} />
          <Text style={[s.text, { flex: 1, fontWeight: "600" }]}>
            Deleting your chat history is permanent.
          </Text>
        </View>
        <Text style={s.muted}>
          This removes all conversations, uploaded photos, files and attachments from this workspace
          forever. There is no way to recover them afterwards.
        </Text>
        <Field
          label={`Type ${CLEAR_HISTORY_CONFIRMATION} to confirm`}
          placeholder={CLEAR_HISTORY_CONFIRMATION}
          value={confirmation}
          onChangeText={setConfirmation}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <ErrorNotice error={error} />
        <Button danger busy={busy} disabled={!confirmed} icon={Trash2} onPress={clearHistory}>
          Delete chat history forever
        </Button>
        <Button onPress={onClose}>Keep my history</Button>
      </View>
    </Sheet>
  );
}
