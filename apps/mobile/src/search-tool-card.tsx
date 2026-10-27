import { Search } from "lucide-react-native";
import { useContext, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import { z } from "zod";
import { BrowserRunContext } from "./browser-tool-card";
import { i18n } from "./i18n";
import { Card, colors, ErrorNotice, s } from "./ui";

const resultSchema = z.object({
  results: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), title: z.string().nullish() })),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});

export function SearchToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { active } = useContext(BrowserRunContext);
  const [linkError, setLinkError] = useState("");
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const error = z.object({ error: z.string() }).safeParse(value);
  const parsed = resultSchema.safeParse(value);
  const working = loading && active;
  const failure = error.success
    ? error.data.error
    : !loading && !parsed.success
      ? i18n.t("search.unreadable")
      : "";
  const sources = parsed.success
    ? [...new Map(parsed.data.results.map((source) => [source.url, source])).values()]
    : [];
  const count = sources.length;
  return (
    <Card
      style={{ padding: 14, gap: 10, backgroundColor: "#EEEEF0", maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        {working ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : (
          <Search size={18} color={colors.blueDark} />
        )}
        <Text style={s.text}>
          {failure
            ? i18n.t("search.failed")
            : working
              ? i18n.t("search.searching")
              : loading
                ? i18n.t("search.stopped")
                : count
                  ? i18n.t("search.found", { count })
                  : i18n.t("search.none")}
        </Text>
      </View>
      {!loading && parsed.success && (
        <>
          {sources.map((source) => (
            <Text
              key={source.url}
              accessibilityRole="link"
              style={[s.text, { color: colors.blueDark }]}
              onPress={() => {
                setLinkError("");
                void Linking.openURL(source.url).catch(() =>
                  setLinkError(i18n.t("search.cannotOpen")),
                );
              }}
            >
              {source.title || source.url}
            </Text>
          ))}
          {parsed.data.truncated && <Text style={s.small}>{i18n.t("chat.searchOmitted")}</Text>}
          {[...new Set(parsed.data.warnings)].map((warning) => (
            <Text key={warning} style={s.small}>
              {warning}
            </Text>
          ))}
        </>
      )}
      <ErrorNotice error={failure || linkError} />
    </Card>
  );
}
