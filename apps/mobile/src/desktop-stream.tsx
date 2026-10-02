import { ExternalLink } from "lucide-react-native";
import { memo, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Linking, Platform, View } from "react-native";
import BrowserConsole from "./BrowserConsole";
import { Button, colors, ErrorNotice } from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Each URL request keeps the computer awake for 30 minutes; a visible stream repeats
// it every 2 minutes, for at most an hour.
const keepAwakeMs = 120000,
  keepAwakeLimitMs = 60 * 60000;

/** The live desktop stream URL of the running computer, kept fresh while shown. */
export function useDesktopStream(running: boolean) {
  const { api } = useWorkspace();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!running) return;
    let alive = true,
      loaded = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      since = Date.now();
    const load = (force = false) => {
      if (!force && (AppState.currentState !== "active" || Date.now() - since > keepAwakeLimitMs))
        return;
      void api
        .request<{ url: string }>("/api/computer/desktop")
        .then((value) => {
          if (!alive) return;
          loaded = true;
          setUrl(value.url);
          setError("");
        })
        .catch((e) => {
          // A loaded stream survives a failed refresh; a first load shows the error and
          // retries shortly instead of waiting for the next refresh.
          if (!alive || loaded) return;
          setError(message(e));
          clearTimeout(retry);
          // Forced: until the first URL arrives, retry even while the app is hidden.
          retry = setTimeout(() => load(true), 5000);
        });
    };
    load(true);
    const interval = setInterval(load, keepAwakeMs);
    // Returning to the app (e.g. from the externally opened desktop) restarts the hour.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      since = Date.now();
      load();
    });
    return () => {
      alive = false;
      clearInterval(interval);
      clearTimeout(retry);
      subscription.remove();
    };
  }, [api, running]);
  return { url, error, setError };
}

/** Web embeds the stream; native opens it in the system browser. Memoized on its
 * props, so a parent re-render never remounts the VNC session. */
export const DesktopStream = memo(function DesktopStream({
  running,
  embed = true,
}: {
  running: boolean;
  /** False shows only the Open desktop button, also on web. */
  embed?: boolean;
}) {
  const embedded = embed && Platform.OS === "web";
  const { api } = useWorkspace();
  const { url, error, setError } = useDesktopStream(running && embedded);
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    setError("");
    try {
      const target =
        embedded && url ? url : (await api.request<{ url: string }>("/api/computer/desktop")).url;
      await Linking.openURL(target);
    } catch (e) {
      setError(message(e));
    } finally {
      setOpening(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={error} />
      {embedded && !url && !error && <ActivityIndicator color={colors.blueDark} />}
      {!!url && embed && Platform.OS === "web" && (
        <BrowserConsole url={url} title="Computer desktop" sandboxed />
      )}
      {running && (!embedded || !!url) && (
        <Button
          icon={ExternalLink}
          primary={Platform.OS !== "web"}
          disabled={opening}
          onPress={() => void open()}
        >
          {opening ? "Opening…" : "Open desktop"}
        </Button>
      )}
    </View>
  );
});
