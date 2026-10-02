import { Monitor, Play } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Image, Platform, Text, View } from "react-native";
import { z } from "zod";
import type { ComputerSnapshot } from "../../../packages/domain/src/computer";
import { useComputerDraft } from "./computer-drafts";
import { DesktopStream } from "./desktop-stream";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const resultSchema = z.object({
  action: z.string().optional(),
  receiptId: z.string().optional(),
  error: z.string().optional(),
});
function parse(result: unknown) {
  if (typeof result !== "string") return undefined;
  try {
    const parsed = resultSchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Chat card for the agent's use_desktop tool: the live desktop on web, the latest
 * screenshot on native, or an offline notice with Start when the computer is stopped. */
export function DesktopToolCard({
  result,
  live = false,
  loading,
}: {
  toolCallId: string;
  live?: boolean;
  result: unknown;
  loading: boolean;
}) {
  const { api, open } = useWorkspace();
  const [, setTab] = useComputerDraft("tab");
  const latest = live;
  const value = parse(result);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot>();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  // Older cards never ask for the stream, so a long thread mounts one VNC session.
  // Poll only the newest card, including changes from the Desktop tab and idle pauses.
  // `loading` re-checks after a step; `starting` prevents an older poll undoing Start.
  useEffect(() => {
    if (!latest || starting) return;
    let alive = true,
      pending = false;
    const refresh = async () => {
      if (pending || AppState.currentState !== "active") return;
      pending = true;
      try {
        const next = await api.request<ComputerSnapshot>("/api/computer");
        if (alive) {
          setSnapshot(next);
          setError("");
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const watching = Platform.OS === "web" && snapshot?.status === "running";
    const interval = loading || watching ? setInterval(() => void refresh(), 5000) : undefined;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      alive = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [api, latest, loading, starting, snapshot?.status]);
  const running = snapshot?.status === "running";
  async function start() {
    setStarting(true);
    setError("");
    try {
      setSnapshot(await api.request<ComputerSnapshot>("/api/computer/start", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, width: "100%", maxWidth: 640 }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 10 }]}>
          <Monitor size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Desktop</Text>
          <Text numberOfLines={1} style={[s.small, { fontSize: 12 }]}>
            {loading
              ? "Using the desktop…"
              : value?.error
                ? "The desktop step failed"
                : (value?.action ?? "Desktop step")}
          </Text>
        </View>
        {loading && <ActivityIndicator size="small" color={colors.blueDark} />}
      </View>
      <ErrorNotice error={value?.error || error} />
      {latest && snapshot && !running ? (
        <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 16, gap: 10 }}>
          <Text style={s.small}>
            The computer is offline. Start it to see the desktop; apps that were open are closed.
          </Text>
          <Button small icon={Play} disabled={starting} onPress={() => void start()}>
            {starting ? "Starting…" : "Start computer"}
          </Button>
        </View>
      ) : latest && running ? (
        Platform.OS === "web" ? (
          <DesktopStream running />
        ) : (
          <>
            {!!value?.receiptId && (
              <Image
                accessibilityLabel="Latest desktop screenshot"
                source={{
                  uri: api.url(`/api/computer/desktop/screenshot?receipt=${value.receiptId}`),
                  headers: { Authorization: `Bearer ${api.token}` },
                }}
                style={{ width: "100%", aspectRatio: 1.6, borderRadius: 12 }}
                resizeMode="contain"
              />
            )}
            <DesktopStream running embed={false} />
          </>
        )
      ) : null}
      <Button
        small
        icon={Monitor}
        onPress={() => {
          setTab("Desktop");
          open({ type: "computer" });
        }}
      >
        Open in Desktop tab
      </Button>
    </Card>
  );
}
