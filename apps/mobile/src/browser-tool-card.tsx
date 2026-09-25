import { Check, ChevronDown, ChevronUp, Globe2, Hand, RotateCw } from "lucide-react-native";
import { createContext, useContext, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src";
import { browserErrorSummary } from "./browser-address";
import { BROWSER_PREVIEW_DEFAULT_COLLAPSED, browserPreviewMaxHeight } from "./browser-panel-layout";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export const BrowserRunContext = createContext({ running: false, active: false });

const observationSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.url(),
});

function resultValue(result: unknown) {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

function siteLabel(url: unknown) {
  if (typeof url !== "string") return "Opening a page";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Opening a page";
  }
}

/** A server tool result stays with the request that produced it, including on replay. */
export function BrowserToolCard({
  url,
  result,
  loading,
}: {
  url: unknown;
  result: unknown;
  loading: boolean;
}) {
  const { api, workspace, open } = useWorkspace();
  const { running, active } = useContext(BrowserRunContext);
  const working = loading && active;
  const value = resultValue(result);
  const observation = observationSchema.safeParse(value);
  const toolError = z.object({ error: z.string() }).safeParse(value);
  const sessionId = observation.success ? observation.data.sessionId : undefined;
  const current = workspace.browsers.find((browser) => browser.id === sessionId);
  const [browser, setBrowser] = useState<BrowserSession>();
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // The preview used to size itself purely from aspectRatio and could swallow
  // the whole chat on wide viewports. It is now height-capped and collapsible
  // so the conversation stays visible and scrollable.
  const [collapsed, setCollapsed] = useState(BROWSER_PREVIEW_DEFAULT_COLLAPSED);
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    async function connect() {
      setError("");
      setPreviewFailed(false);
      try {
        const session = await api.request<BrowserSession>(
          `/api/browsers/${encodeURIComponent(sessionId || "")}`,
        );
        if (active) setBrowser(session);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void connect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [api, sessionId, current?.updatedAt, retry]);

  const visited = observation.success ? observation.data : undefined;
  // A later turn can reuse the same browser. Never label that new page as an old source.
  const preview =
    browser?.status === "active" && browser.url === visited?.url && !previewFailed
      ? browser.previewUrl
      : undefined;
  // Status dot: green = live session, red = error/closed, gray = idle/loading.
  const statusDot =
    browser?.status === "error" || browser?.status === "closed" || toolError.success
      ? "#D64545"
      : browser?.status === "active"
        ? "#3FA45B"
        : "#B9BEC4";
  const canControl = !!browser && !running && !loading;
  const failure = toolError.success
    ? toolError.data.error
    : !loading && !visited
      ? "The browser did not return a page. Try your request again."
      : "";
  return (
    <Card
      style={{ padding: 12, backgroundColor: "#EEEEF0", gap: 10, width: "100%", maxWidth: 640 }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 10 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <View style={[s.row, { gap: 6, alignItems: "center" }]}>
            <View
              accessibilityLabel={
                statusDot === "#3FA45B"
                  ? "Browser session active"
                  : statusDot === "#D64545"
                    ? "Browser session needs attention"
                    : "Browser session idle"
              }
              style={{
                width: 9,
                height: 9,
                borderRadius: 5,
                backgroundColor: statusDot,
              }}
            />
            <Text style={[s.text, { fontWeight: "600" }]}>Browser</Text>
          </View>
          <Text numberOfLines={1} style={[s.small, { fontSize: 12 }]}>
            {working
              ? "Reading the page…"
              : loading
                ? "Browsing paused"
                : failure
                  ? browserErrorSummary(failure)
                  : siteLabel(visited?.url)}
          </Text>
        </View>
        {working ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : visited ? (
          <Check size={17} color="#47896C" accessibilityLabel="Page read" />
        ) : null}
        {collapsed && canControl && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take control of the browser"
            onPress={() => browser && open({ type: "browser", browser })}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: "#E4E9F2",
            }}
          >
            <Text style={[s.small, { fontWeight: "600", color: colors.blueDark }]}>Control</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? "Expand browser preview" : "Collapse browser preview"}
          onPress={() => setCollapsed((value) => !value)}
          style={{ padding: 6, borderRadius: 8 }}
        >
          {collapsed ? (
            <ChevronDown size={18} color={colors.muted} />
          ) : (
            <ChevronUp size={18} color={colors.muted} />
          )}
        </Pressable>
      </View>
      {!collapsed && (
        <>
          {preview ? (
            <Image
              accessibilityLabel={`Browser preview: ${visited?.title}`}
              source={{ uri: api.url(preview) }}
              style={{
                width: "100%",
                aspectRatio: 1.7,
                borderRadius: 12,
                backgroundColor: "#FFF",
                maxHeight: browserPreviewMaxHeight(windowHeight),
              }}
              resizeMode="contain"
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 16, gap: 10 }}>
              <Text numberOfLines={2} style={[s.text, { fontSize: 14 }]}>
                {visited?.title || siteLabel(url)}
              </Text>
              {working ? (
                <View style={{ gap: 8 }}>
                  {(["90%", "74%", "84%"] as const).map((width) => (
                    <View
                      key={width}
                      style={{ height: 7, width, borderRadius: 4, backgroundColor: "#E3E9ED" }}
                    />
                  ))}
                </View>
              ) : visited ? (
                <Text style={s.small}>
                  {browser && browser.url !== visited.url
                    ? "Page visited. The browser has moved on."
                    : browser?.status === "closed"
                      ? "Session saved. Take control to reopen it."
                      : browser?.status === "error"
                        ? "Session needs attention. Take control to reconnect."
                        : previewFailed
                          ? "Preview unavailable. You can still take control."
                          : "Connecting to the saved session…"}
                </Text>
              ) : null}
            </View>
          )}
          {!loading && visited && (
            <Button
              icon={Hand}
              disabled={!browser || running}
              onPress={() => browser && open({ type: "browser", browser })}
              style={{ backgroundColor: "#F9F9FA", minHeight: 44, paddingVertical: 10 }}
            >
              Take control
            </Button>
          )}
          {!!error && (
            <Button small icon={RotateCw} onPress={() => setRetry((attempt) => attempt + 1)}>
              Reconnect preview
            </Button>
          )}
        </>
      )}
      <ErrorNotice error={failure || error} />
    </Card>
  );
}
