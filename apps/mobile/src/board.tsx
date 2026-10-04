import { KanbanSquare, Link2, Loader } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { BoardState } from "../../../packages/domain/src/board.ts";
import { statusLabel } from "./agent-ui.tsx";
import type { Board, BoardTask } from "./board-model.ts";
import { boardTotal, COLUMN_LABEL, isVisibleColumn, waitingLabel } from "./board-model.ts";
import { Button, Card, colors, Empty, ErrorNotice, relativeDate, s } from "./ui.tsx";
import { useWorkspace } from "./workspace.tsx";

export type { Board, BoardTask } from "./board-model.ts";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The board: every task grouped by where it sits, with only the moves the
 * server will accept.
 *
 * `allowedTransitions` comes from the server rather than a local copy of the
 * transition table. That table is the rule the API enforces; a second copy here
 * would drift and start offering moves that 409.
 */
export function BoardScreen() {
  const { api, open, refresh } = useWorkspace();
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState<{ task: BoardTask; to: BoardState }>();

  const load = useCallback(async () => {
    try {
      const next = await api.request<Board>("/api/agent/tasks/board");
      setBoard(next);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async (task: BoardTask, to: BoardState) => {
    setMoving({ task, to });
    try {
      await api.request(`/api/agent/tasks/${task.id}/board`, { to });
      // Reload rather than patching locally: the server owns the board, and a
      // move can also land somewhere else (a failed gate forces InProgress).
      await Promise.all([load(), refresh()]);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMoving(undefined);
    }
  };

  const total = boardTotal(board);
  const columns = (board?.columns ?? []).filter((column) => isVisibleColumn(column.boardState));

  return (
    <View style={{ gap: 20 }}>
      <ErrorNotice error={error} />
      {loading && !board ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <Loader size={22} color={colors.muted} />
        </View>
      ) : total === 0 ? (
        <Empty
          icon={KanbanSquare}
          title="Nothing on the board yet"
          detail="Delegate a task in Chat. It lands in Backlog, and you move it along as the work progresses."
        />
      ) : (
        // Horizontal scroll rather than a stacked list: the point of a board is
        // seeing where work sits relative to everything else, and on a phone
        // that means columns side by side.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 14, paddingRight: 4 }}
        >
          {columns.map((column) => (
            <View key={column.boardState} style={{ width: 268, gap: 10 }}>
              <View style={[s.between, { paddingHorizontal: 2 }]}>
                <Text style={[s.small, { color: colors.text, fontWeight: "700" }]}>
                  {COLUMN_LABEL[column.boardState]}
                </Text>
                <Text style={s.small}>{column.tasks.length}</Text>
              </View>
              <View style={{ gap: 10 }}>
                {column.tasks.map((task) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    busy={moving?.task.id === task.id}
                    onOpen={() => open({ type: "task", taskId: task.id })}
                    onMove={(to) => void move(task, to)}
                  />
                ))}
                {column.tasks.length === 0 && (
                  <View
                    style={{
                      padding: 18,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: colors.line,
                      borderStyle: "dashed",
                    }}
                  >
                    <Text style={[s.small, { textAlign: "center" }]}>Empty</Text>
                  </View>
                )}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function BoardCard({
  task,
  busy,
  onOpen,
  onMove,
}: {
  task: BoardTask;
  busy: boolean;
  onOpen: () => void;
  onMove: (to: BoardState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card style={{ padding: 15, gap: 11, borderRadius: 18, backgroundColor: "#F7F8F9" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open task: ${task.title}`}
        onPress={onOpen}
        style={{ gap: 4 }}
      >
        <Text style={s.heading}>{task.title}</Text>
        <Text style={s.small}>
          {statusLabel(task.status)} · {relativeDate(task.updatedAt)}
        </Text>
      </Pressable>
      {task.blocked && (
        <View style={[s.row, { gap: 6 }]}>
          {/* The scheduler will not start this until its prerequisites settle,
              so say why rather than showing a task that looks merely queued. */}
          <Link2 size={13} color={colors.muted} />
          <Text style={s.small}>{waitingLabel(task.dependsOn)}</Text>
        </View>
      )}
      {task.allowedTransitions.length > 0 && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Hide moves" : "Show moves"}
            onPress={() => setExpanded(!expanded)}
          >
            <Text style={[s.small, { color: colors.blueDark }]}>
              {expanded ? "Hide moves" : "Move"}
            </Text>
          </Pressable>
          {expanded && (
            <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
              {task.allowedTransitions.map((to) => (
                <Button key={to} small busy={busy} onPress={() => onMove(to)}>
                  {COLUMN_LABEL[to]}
                </Button>
              ))}
            </View>
          )}
        </>
      )}
    </Card>
  );
}
