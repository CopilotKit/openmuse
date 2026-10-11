import { Mail, Search } from "lucide-react-native";
import { useContext } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { z } from "zod";
import { BrowserRunContext } from "./browser-tool-card";
import { i18n } from "./i18n";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  date: z.string(),
  unread: z.boolean(),
  label: z.string(),
  attachments: z.array(z.string()),
});

export function MailToolCard({
  result,
  loading,
  search = false,
}: {
  result: unknown;
  loading: boolean;
  search?: boolean;
}) {
  const { open } = useWorkspace();
  const { active } = useContext(BrowserRunContext);
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success) return <ErrorNotice error={error.data.error} />;
  if (loading)
    return (
      <View style={[s.row, { gap: 10, padding: 14 }]}>
        {active ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : (
          <Mail size={16} color={colors.muted} />
        )}
        <Text style={s.muted}>
          {!active
            ? i18n.t("mail.paused")
            : search
              ? i18n.t("mail.checking")
              : i18n.t("mail.reading")}
        </Text>
      </View>
    );
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ id: z.string() })), truncated: z.boolean() })
      .safeParse(value);
    if (!parsed.success) return <ErrorNotice error={i18n.t("mail.unreadable")} />;
    const count = parsed.data.matches.length;
    return (
      <View style={[s.row, { gap: 9, padding: 12 }]}>
        <Search size={16} color={colors.muted} />
        <Text style={s.muted}>
          {count
            ? i18n.t(parsed.data.truncated ? "mail.foundAtLeast" : "mail.foundEmails", { count })
            : i18n.t("mail.noMatches")}
        </Text>
      </View>
    );
  }
  const parsed = z
    .object({ messages: z.array(messageSchema), truncated: z.boolean() })
    .safeParse(value);
  if (!parsed.success) return <ErrorNotice error={i18n.t("mail.cannotDisplay")} />;
  const message = parsed.data.messages.at(-1);
  if (!message) return <Text style={s.muted}>{i18n.t("mail.noMessages")}</Text>;
  return (
    <Card
      style={{ padding: 18, gap: 14, backgroundColor: "#F0EFF2", maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { backgroundColor: "#E9F5FC" }]}>
          <Mail size={20} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>{message.sender}</Text>
          <Text style={s.small}>
            {i18n.t("mail.emailCount", { count: parsed.data.messages.length })}
          </Text>
        </View>
      </View>
      <Text style={s.heading}>{message.subject}</Text>
      <Text style={s.muted} numberOfLines={3}>
        {message.body}
      </Text>
      {parsed.data.truncated && <Text style={s.small}>{i18n.t("mail.excerpt")}</Text>}
      <Button small icon={Mail} onPress={() => open({ type: "mail", mail: message })}>
        {i18n.t("mail.openEmail")}
      </Button>
    </Card>
  );
}
