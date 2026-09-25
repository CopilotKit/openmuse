import { Check, Globe2, Hand, RotateCw } from "lucide-react-native";
import { createContext, useContext, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Image, Text, View } from "react-native";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src";
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

/** A short description of a browser_act step; typed text is never shown. */
export function browserActionLabel(args: Record<string, unknown>, result: unknown) {
  const value = resultValue(result);
  const name = z.object({ target: z.string().min(1) }).safeParse(value);
  const target = name.success ? `“${name.data.target}”` : "an element";
  switch (args.action) {
    case "click":
      return `Clicked ${target}`;
    case "type":
      return `Typed into ${target}`;
    case "select":
      return typeof args.option === "string" ? `Chose “${args.option}”` : "Chose an option";
    case "check":
      return args.checked === false ? `Unchecked ${target}` : `Checked ${target}`;
    case "press":
      return typeof args.key === "string" ? `Pressed ${args.key}` : "Pressed a key";
    case "scroll":
      return args.direction === "up" ? "Scrolled up" : "Scrolled down";
    default:
      return "Used the page";
  }
}

/** A one-line note for browser steps that do not change the page. */
export function BrowserStepNote({
  text,
  error,
  loading,
}: {
  text: string;
  error?: string;
  loading: boolean;
}) {
  return (
    <View style={[s.row, { gap: 8, paddingHorizontal: 4 }]}>
      {loading ? (
        <ActivityIndicator size="small" color={colors.blueDark} />
      ) : (
        <Globe2 size={15} color={error ? colors.danger : colors.muted} />
      )}
      <Text
        style={[s.small, { fontSize: 12, flex: 1, color: error ? colors.danger : colors.muted }]}
      >
        {error || text}
      </Text>
    </View>
  );
}

export function browserElementsNote(result: unknown) {
  const value = resultValue(result);
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success) return { text: "", error: error.data.error };
  const list = z.object({ elements: z.array(z.unknown()) }).safeParse(value);
  return {
    text: list.success
      ? `Looked at ${list.data.elements.length} links, buttons and fields`
      : "Looking at the page’s links, buttons and fields…",
  };
}

export function browserDownloadsNote(result: unknown) {
  const value = resultValue(result);
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success) return { text: "", error: error.data.error };
  const outcome = z
    .object({
      saved: z.array(z.object({ name: z.string() })),
      failed: z.array(z.object({ name: z.string() })),
    })
    .safeParse(value);
  if (!outcome.success) return { text: "Saving downloads to Files…" };
  const saved = outcome.data.saved.map((file) => file.name);
  const failed = outcome.data.failed.length
    ? ` · ${outcome.data.failed.length} could not be saved`
    : "";
  return {
    text: saved.length
      ? `Saved to Files: ${saved.join(", ")}${failed}`
      : `No PDF downloads to save${failed}`,
  };
}

/** A server tool result stays with the request that produced it, including on replay. */
export function BrowserToolCard({
  url,
  result,
  loading,
  action,
}: {
  url: unknown;
  result: unknown;
  loading: boolean;
  /** Set for browser_act steps; describes what was done on the page. */
  action?: string;
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
  const failure = toolError.success
    ? toolError.data.error
    : !loading && !visited
      ? "The browser did not return a page. Try your request again."
      : "";
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, width: "100%", maxWidth: 440 }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 10 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Browser</Text>
          <Text numberOfLines={1} style={[s.small, { fontSize: 12 }]}>
            {working
              ? action
                ? "Working on the page…"
                : "Reading the page…"
              : loading
                ? "Browsing paused"
                : failure
                  ? action
                    ? "Couldn’t do that on the page"
                    : "Couldn’t read the page"
                  : action
                    ? `${action} · ${siteLabel(visited?.url)}`
                    : siteLabel(visited?.url)}
          </Text>
        </View>
        {working ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : visited ? (
          <Check size={17} color="#47896C" accessibilityLabel="Page read" />
        ) : null}
      </View>
      {preview ? (
        <Image
          accessibilityLabel={`Browser preview: ${visited?.title}`}
          source={{ uri: api.url(preview) }}
          style={{ width: "100%", aspectRatio: 1.7, borderRadius: 12, backgroundColor: "#FFF" }}
          resizeMode="contain"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 21, gap: 12 }}>
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
      <ErrorNotice error={failure || error} />
      {!loading && visited && (
        <Button
          icon={Hand}
          disabled={!browser || running}
          onPress={() => browser && open({ type: "browser", browser })}
          style={{ backgroundColor: "#F9F9FA", minHeight: 38, paddingVertical: 8 }}
        >
          Take control
        </Button>
      )}
      {!!error && (
        <Button small icon={RotateCw} onPress={() => setRetry((attempt) => attempt + 1)}>
          Reconnect preview
        </Button>
      )}
    </Card>
  );
}
