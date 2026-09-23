import { useCallback, useState } from "react";
import { Linking, Text } from "react-native";
import Markdown, { type MarkdownStyles, type RenderRules } from "react-native-markdown-renderer";
import { assistantMarkdown, isSafeAssistantUrl } from "./assistant-markdown";
import { colors, ErrorNotice } from "./ui";

const style: Partial<MarkdownStyles> = {
  text: { color: colors.text, fontSize: 16, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 6 },
  list: { marginBottom: 6 },
  headingContainer: { marginTop: 8, marginBottom: 4 },
  heading1: { fontSize: 21, lineHeight: 27 },
  heading2: { fontSize: 19, lineHeight: 25 },
  heading3: { fontSize: 17, lineHeight: 23 },
  link: { color: colors.blueDark, textDecorationLine: "underline" },
  codeInline: { backgroundColor: "#E2E4E7", color: colors.text },
  codeBlock: { backgroundColor: "#E2E4E7", color: colors.text },
};
const rules: RenderRules = {
  image: (node) => (
    <Text key={node.key} style={{ color: colors.muted }}>
      {node.attributes.alt ? `[Image: ${node.attributes.alt}]` : "[Image]"}
    </Text>
  ),
};

export function AssistantResponse({ content }: { content: string }) {
  const [linkError, setLinkError] = useState("");
  const onLinkPress = useCallback((url: string) => {
    if (!isSafeAssistantUrl(url)) return false;
    setLinkError("");
    void Linking.openURL(url).catch((error) =>
      setLinkError(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }, []);
  return (
    <>
      <Markdown
        markdownit={assistantMarkdown}
        style={style}
        rules={rules}
        onLinkPress={onLinkPress}
      >
        {content}
      </Markdown>
      <ErrorNotice error={linkError} />
    </>
  );
}
