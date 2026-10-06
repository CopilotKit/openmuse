import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { ErrorNotice } from "./ui";
// `title` labels the web iframe; the native WebView has no equivalent.
export default function BrowserConsole({
  url,
}: {
  url: string;
  title?: string;
  sandboxed?: boolean;
}) {
  const [error, setError] = useState("");
  return (
    <View>
      <ErrorNotice error={error} />
      <WebView
        source={{ uri: url }}
        onError={(event) => setError(event.nativeEvent.description)}
        style={{ height: 520, borderRadius: 12 }}
      />
    </View>
  );
}
