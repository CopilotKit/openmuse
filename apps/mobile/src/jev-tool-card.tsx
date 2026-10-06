import { Check, ExternalLink } from "lucide-react-native";
import { createContext, useContext, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import type { JevOption, JevPanel } from "../../../packages/domain/src/jev";
import {
  choiceAvailability,
  parseJevResult,
  retryChoiceAvailable,
  selectionText,
} from "./jev-actions";
import { Button, Card, colors, ErrorNotice, s } from "./ui";

type JevInteraction = {
  threadId: string | null;
  busy: boolean;
  latestPanelId: string | null;
  latestUserText: string | null;
  send: (text: string) => Promise<void>;
  retry: (text: string) => Promise<void>;
  canRetry: boolean;
  confirmedSelection: (panelId: string) => string | null;
};

export const JevInteractionContext = createContext<JevInteraction>({
  threadId: null,
  busy: true,
  latestPanelId: null,
  latestUserText: null,
  canRetry: false,
  confirmedSelection: () => null,
  send: async () => {
    throw new Error("Open an active conversation to choose an option.");
  },
  retry: async () => {
    throw new Error("Open an active conversation to retry a choice.");
  },
});

function SourceLink({ title, url }: { title: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Source: ${title}`}
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [s.row, { gap: 4, opacity: pressed ? 0.65 : 1 }]}
    >
      <Text style={[s.small, { color: colors.blueDark, textDecorationLine: "underline" }]}>
        {title}
      </Text>
      <ExternalLink size={12} color={colors.blueDark} />
    </Pressable>
  );
}

function ChoiceButton({
  panel,
  option,
  disabled,
  pending,
  selected,
  position,
  onChoose,
}: {
  panel: JevPanel;
  option: JevOption;
  disabled: boolean;
  pending: boolean;
  selected: boolean;
  position: number;
  onChoose: (optionId: string) => void;
}) {
  if (panel.type === "comparison") {
    const caption = /exhibit/i.test(panel.title) ? "Choose this exhibit" : "Choose this option";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${caption}: ${option.label} (option ${position})`}
        accessibilityState={{ disabled: disabled || pending, busy: pending, selected }}
        disabled={disabled || pending}
        onPress={() => onChoose(option.id)}
        style={({ pressed }) => [
          s.button,
          { alignSelf: "flex-start", backgroundColor: colors.blue },
          (disabled || pending) && { opacity: 0.5 },
          pressed && { transform: [{ scale: 0.98 }] },
        ]}
      >
        {pending ? (
          <ActivityIndicator size="small" color={colors.text} />
        ) : selected ? (
          <Check size={15} color={colors.text} />
        ) : null}
        <Text style={s.buttonText}>{caption}</Text>
      </Pressable>
    );
  }
  return (
    <Button
      small
      disabled={disabled}
      busy={pending}
      icon={selected ? Check : undefined}
      onPress={() => onChoose(option.id)}
    >
      {option.label}
    </Button>
  );
}

export function JevToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const interaction = useContext(JevInteractionContext);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [failedOptionId, setFailedOptionId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const pendingRef = useRef(false);
  if (loading) {
    return (
      <View style={[s.row, { gap: 10, padding: 14 }]}>
        <ActivityIndicator size="small" color={colors.blueDark} />
        <Text style={s.muted}>Preparing choices…</Text>
      </View>
    );
  }

  const parsed = parseJevResult(result);
  if (!parsed) return <ErrorNotice error="The choices could not be displayed. Please retry." />;
  if (parsed.error) return <ErrorNotice error={parsed.error} />;
  const panel = parsed.panel;
  if (!panel) return null;

  const availability = choiceAvailability(
    panel,
    interaction.threadId || "",
    interaction.latestPanelId,
    interaction.busy,
    submittingId !== null ||
      confirmedId !== null ||
      interaction.confirmedSelection(panel.id) !== null,
  );
  const stale = availability === "wrong-thread" || availability === "stale";
  const selectedId = panel.selectedId || confirmedId || interaction.confirmedSelection(panel.id);
  const preferredOption = panel.preferredId
    ? panel.options.find((option) => option.id === panel.preferredId)
    : undefined;
  const disabled = availability !== "ready";

  async function choose(optionId: string, retrying = false) {
    const priorConfirmedId =
      panel?.selectedId || confirmedId || (panel && interaction.confirmedSelection(panel.id));
    if (
      !panel ||
      pendingRef.current ||
      priorConfirmedId ||
      (retrying
        ? !retryChoiceAvailable(
            panel,
            interaction.threadId || "",
            interaction.latestPanelId,
            failedOptionId,
            interaction.latestUserText,
            !!priorConfirmedId,
            !interaction.canRetry,
          ) || optionId !== failedOptionId
        : choiceAvailability(
            panel,
            interaction.threadId || "",
            interaction.latestPanelId,
            interaction.busy,
            false,
          ) !== "ready")
    )
      return;
    pendingRef.current = true;
    setSubmittingId(optionId);
    setSubmitError("");
    try {
      await (retrying ? interaction.retry : interaction.send)(selectionText(panel, optionId));
      setConfirmedId(optionId);
      setFailedOptionId(null);
    } catch (error) {
      setFailedOptionId(optionId);
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setSubmittingId(null);
    }
  }

  return (
    <Card style={{ width: "100%", maxWidth: 440, padding: 17, gap: 13 }}>
      <View style={{ gap: 5 }}>
        <Text style={s.heading}>{panel.title}</Text>
        {panel.mode === "sample" && <Text style={s.small}>Sample · scripted decisions</Text>}
        {panel.mode === "live" && <Text style={s.small}>Live Jev · model decisions</Text>}
        {preferredOption && !selectedId && (
          <Text style={s.small}>Previous preference: {preferredOption.label}</Text>
        )}
        {stale && <Text style={s.small}>Earlier choices</Text>}
        {selectedId && <Text style={s.small}>Choice submitted</Text>}
      </View>
      {panel.type === "clarification" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {panel.options.map((option, index) => (
            <ChoiceButton
              key={option.id}
              panel={panel}
              option={option}
              disabled={disabled}
              pending={submittingId === option.id}
              selected={selectedId === option.id}
              position={index + 1}
              onChoose={(id) => void choose(id)}
            />
          ))}
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {panel.options.map((option, index) => (
            <View
              key={option.id}
              style={{ borderRadius: 16, padding: 14, gap: 9, backgroundColor: "#F6F7F8" }}
            >
              <Text style={[s.text, { fontWeight: "600" }]}>{option.label}</Text>
              {!!option.details.length && (
                <Text style={s.muted}>
                  {option.details.map((detail) => `• ${detail}`).join("\n")}
                </Text>
              )}
              <View style={{ gap: 5 }}>
                {option.sources.map((source) => (
                  <SourceLink key={`${option.id}-${source.url}`} {...source} />
                ))}
              </View>
              <ChoiceButton
                panel={panel}
                option={option}
                disabled={disabled}
                pending={submittingId === option.id}
                selected={selectedId === option.id}
                position={index + 1}
                onChoose={(id) => void choose(id)}
              />
            </View>
          ))}
        </View>
      )}
      <ErrorNotice error={submitError} />
      {failedOptionId && !selectedId && (
        <Button
          small
          disabled={
            !retryChoiceAvailable(
              panel,
              interaction.threadId || "",
              interaction.latestPanelId,
              failedOptionId,
              interaction.latestUserText,
              false,
              !interaction.canRetry || submittingId !== null,
            )
          }
          onPress={() => void choose(failedOptionId, true)}
        >
          Retry choice
        </Button>
      )}
    </Card>
  );
}
