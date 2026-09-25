import { RotateCcw, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { setMascotSource } from "./mascot-state";
import { Button, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export type RestartBrowserResult = {
  closedSessions: number;
  clearedSessions: number;
  clearedCommands: number;
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function RestartBrowserSheet({
  onClose,
  onRestarted,
}: {
  onClose: () => void;
  onRestarted?: () => void;
}) {
  const { api, refresh, notify } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function restart() {
    if (busy) return;
    setBusy(true);
    setError("");
    // Real work: browser sessions are being torn down right now.
    setMascotSource("maintenance", "restarting_browser");
    try {
      const result = await api.request<RestartBrowserResult>("/api/browsers/restart", {}, "POST");
      await refresh();
      notify(
        [
          `Browser restarted: ${plural(result.closedSessions, "session", "sessions")} closed`,
          `${plural(result.clearedSessions, "saved session", "saved sessions")} cleared`,
          `${plural(result.clearedCommands, "terminal command", "terminal commands")} cleared`,
        ].join(" · "),
      );
      onRestarted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMascotSource("maintenance", "idle");
      setBusy(false);
    }
  }

  return (
    <Sheet title="Restart browser" subtitle="Close everything and start fresh" onClose={onClose}>
      <View style={{ gap: 14 }}>
        <View style={[s.row, { gap: 10 }]}>
          <TriangleAlert size={20} color={colors.danger} />
          <Text style={[s.text, { flex: 1, fontWeight: "600" }]}>
            This closes every open browser tab.
          </Text>
        </View>
        <Text style={s.muted}>
          All active browser sessions are closed, the saved session list is cleared, and the
          terminal command history is wiped. Your files and downloads are kept.
        </Text>
        <ErrorNotice error={error} />
        <Button danger busy={busy} icon={RotateCcw} onPress={restart}>
          Restart browser
        </Button>
        <Button onPress={onClose}>Cancel</Button>
      </View>
    </Sheet>
  );
}

export function RestartBrowserButton({
  small,
  onRestarted,
}: {
  small?: boolean;
  onRestarted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button small={small} icon={RotateCcw} onPress={() => setOpen(true)}>
        Restart browser
      </Button>
      {open && (
        <RestartBrowserSheet
          onClose={() => setOpen(false)}
          onRestarted={() => {
            setOpen(false);
            onRestarted?.();
          }}
        />
      )}
    </>
  );
}
