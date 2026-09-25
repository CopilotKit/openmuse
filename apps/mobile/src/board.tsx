import { Play, Plus } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import type { CardStatus, WorkboardCard } from "../../../packages/domain/src/agent";
import { createWorkboardClient, type WorkboardBoard, type WorkboardClient } from "./api";
import { Button, Card, Chip, colors, Empty, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const COLUMNS: { status: CardStatus; label: string; tint: string }[] = [
  { status: "backlog", label: "Backlog", tint: "#E8EAED" },
  { status: "todo", label: "To do", tint: "#D7E9FA" },
  { status: "doing", label: "Doing", tint: "#FDECC8" },
  { status: "review", label: "Review", tint: "#E4DFF7" },
  { status: "done", label: "Done", tint: "#D9F1E2" },
  { status: "failed", label: "Failed", tint: "#FADDD8" },
];

const PRIORITY_TINT: Record<WorkboardCard["priority"], string> = {
  low: "#E8EAED",
  medium: "#D7E9FA",
  high: "#FADDD8",
};

function columnLabel(status: CardStatus) {
  return COLUMNS.find((c) => c.status === status)?.label ?? status;
}

/**
 * Kanban board of agent-work cards, backed by the task worker. Cards move as
 * tasks run and settle; the board polls every 5s while visible. Card content
 * is rendered as plain text only (no HTML/WebView).
 */
export function Workboard() {
  const { api } = useWorkspace();
  const client: WorkboardClient = useMemo(() => createWorkboardClient(api), [api]);
  const [board, setBoard] = useState<WorkboardBoard>();
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState(false);

  const load = useMemo(
    () => async () => {
      const next = await client.board();
      setBoard(next);
      setError("");
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    void load().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    const timer = setInterval(() => {
      // Visible-only polling: pause while the app is backgrounded.
      if (cancelled || AppState.currentState !== "active") return;
      void load().catch(() => {});
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  const selected = board?.cards.find((card) => card.id === selectedId);

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { marginBottom: 2 }]}>
        <Text style={s.muted}>
          {board ? `${board.stats.active} active · ${board.stats.total} total` : "Loading board…"}
        </Text>
        <Button small icon={Plus} onPress={() => setAdding(true)}>
          Card
        </Button>
      </View>
      <ErrorNotice error={error} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", gap: 12 }}>
          {COLUMNS.map((column) => {
            const cards = (board?.cards ?? []).filter((card) => card.status === column.status);
            return (
              <View key={column.status} style={{ width: 264, gap: 10 }}>
                <View style={[s.row, { gap: 8, alignItems: "center" }]}>
                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: column.tint,
                      borderWidth: 1,
                      borderColor: colors.line,
                    }}
                  />
                  <Text style={[s.heading, { fontSize: 14 }]}>{column.label}</Text>
                  <Chip tint={column.tint}>{String(cards.length)}</Chip>
                </View>
                {cards.map((card) => (
                  <WorkboardCardView
                    key={card.id}
                    card={card}
                    tint={column.tint}
                    onOpen={() => setSelectedId(card.id)}
                  />
                ))}
                {!cards.length && <Text style={[s.small, { color: colors.muted }]}>Empty</Text>}
              </View>
            );
          })}
        </View>
      </ScrollView>
      {!board?.cards.length && !error && (
        <Empty
          icon={Plus}
          title="No cards yet"
          detail="Create a card here or ask in chat, then dispatch it to the task worker."
        />
      )}
      {adding && (
        <Sheet title="New card" onClose={() => setAdding(false)}>
          <NewCardForm
            client={client}
            onDone={async () => {
              setAdding(false);
              await load().catch(() => {});
            }}
          />
        </Sheet>
      )}
      {selected && (
        <Sheet title={selected.title} onClose={() => setSelectedId(undefined)}>
          <CardDetailSheet
            card={selected}
            client={client}
            onChanged={async () => {
              await load().catch(() => {});
            }}
            onClose={() => setSelectedId(undefined)}
          />
        </Sheet>
      )}
    </View>
  );
}

function WorkboardCardView({
  card,
  tint,
  onOpen,
}: {
  card: WorkboardCard;
  tint: string;
  onOpen: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open card: ${card.title}`}
      onPress={onOpen}
    >
      <Card style={{ padding: 14, gap: 8 }}>
        <Text style={[s.text, { fontWeight: "600" }]}>{card.title}</Text>
        {!!card.description && (
          <Text numberOfLines={2} style={s.muted}>
            {card.description}
          </Text>
        )}
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          <Chip tint={PRIORITY_TINT[card.priority]}>{card.priority}</Chip>
          {card.labels.slice(0, 3).map((label) => (
            <Chip key={label} tint={tint}>
              {label}
            </Chip>
          ))}
          {(card.taskId || card.fanoutId) && <Chip tint="#FDECC8">dispatched</Chip>}
          {card.childCardIds.length > 0 && (
            <Chip tint={tint}>
              {card.childCardIds.length} subagent{card.childCardIds.length === 1 ? "" : "s"}
            </Chip>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

function CardDetailSheet({
  card,
  client,
  onChanged,
  onClose,
}: {
  card: WorkboardCard;
  client: WorkboardClient;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dispatchable =
    (card.status === "backlog" || card.status === "todo") && !card.taskId && !card.fanoutId;

  async function move(status: CardStatus) {
    if (status === card.status) return;
    setBusy(true);
    setError("");
    try {
      // updatedAt is the compare-and-swap token: a stale value is rejected
      // with 409 so a concurrent move is never silently overwritten.
      await client.moveCard(card.id, { status, updatedAt: card.updatedAt });
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onChanged().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function dispatch() {
    setBusy(true);
    setError("");
    try {
      // Tapping Dispatch in the app IS the owner's approval; fan-out (which
      // spends N model runs) is proposed from chat as a reviewed action.
      await client.dispatch(card.id);
      await onChanged();
      onClose();
    } catch (e) {
      // 409 surfaces the caps: the 100-active-task limit or a stale card.
      setError(e instanceof Error ? e.message : String(e));
      await onChanged().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Chip>{columnLabel(card.status)}</Chip>
        <Chip tint={PRIORITY_TINT[card.priority]}>{card.priority}</Chip>
        {card.labels.map((label) => (
          <Chip key={label}>{label}</Chip>
        ))}
      </View>
      {!!card.description && (
        <Text selectable style={[s.text, { lineHeight: 24 }]}>
          {card.description}
        </Text>
      )}
      <View style={{ gap: 6 }}>
        <Text style={s.label}>Move to</Text>
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          {COLUMNS.map((column) => (
            <Button
              key={column.status}
              small
              primary={card.status === column.status}
              disabled={busy || card.status === column.status}
              onPress={() => void move(column.status)}
            >
              {column.label}
            </Button>
          ))}
        </View>
      </View>
      {dispatchable && (
        <Button primary icon={Play} busy={busy} onPress={() => void dispatch()}>
          Dispatch as task
        </Button>
      )}
      {!dispatchable && (card.taskId || card.fanoutId) && (
        <Text style={s.muted}>
          {card.fanoutId
            ? `Fanned out to ${card.childCardIds.length} subagent${card.childCardIds.length === 1 ? "" : "s"}. Watch the child cards move.`
            : "Dispatched to the task worker. The card moves as the task runs and settles."}
        </Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}

function NewCardForm({ client, onDone }: { client: WorkboardClient; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkboardCard["priority"]>("medium");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!title.trim()) {
      setError("Give the card a title.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await client.createCard({
        title: title.trim(),
        description: description.trim(),
        priority,
      });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={160} />
      <Field
        label="Details (plain text)"
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={4000}
      />
      <View style={{ gap: 6 }}>
        <Text style={s.label}>Priority</Text>
        <View style={[s.row, { gap: 6 }]}>
          {(["low", "medium", "high"] as const).map((level) => (
            <Button
              key={level}
              small
              primary={priority === level}
              onPress={() => setPriority(level)}
            >
              {level}
            </Button>
          ))}
        </View>
      </View>
      <ErrorNotice error={error} />
      <Button primary busy={busy} disabled={!title.trim()} onPress={() => void create()}>
        Create card
      </Button>
    </View>
  );
}
