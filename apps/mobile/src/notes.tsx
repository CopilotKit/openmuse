import { Loader, NotebookPen } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  canSaveNote,
  type NoteRow,
  noteHeading,
  noteTooLong,
  openNoteCount,
  orderedNotes,
  promotionAction,
} from "./notes-model.ts";
import { Button, Card, colors, Empty, ErrorNotice, Field, relativeDate, s } from "./ui.tsx";
import { useWorkspace } from "./workspace.tsx";

export type { NoteRow } from "./notes-model.ts";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Notes: capture here, promote deliberately, watch the work on the board.
 *
 * The screen is built around the one rule that matters — **a note is not work.**
 * Saving a note never starts anything, and the only way to a task is the explicit
 * "Make it a task" button on that note. A capture surface that silently queued
 * work would be work the user never asked for, and this agent is single-user, so
 * "never asked for" is indistinguishable from "a nuisance".
 *
 * Everything derived — ordering, the promotion affordance, the save gate — lives
 * in `notes-model.ts`, which a `node --test` run can load. This file is the
 * `react-native` shell around those decisions.
 */
export function NotesScreen() {
  const { api } = useWorkspace();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setNotes(await api.request<NoteRow[]>("/api/agent/notes"));
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

  const save = async () => {
    if (!canSaveNote(draft) || noteTooLong(draft)) return;
    setBusy("save");
    try {
      await api.request("/api/agent/notes", { body: draft });
      // Cleared only after the write lands: emptying the box on an optimistic
      // save would lose the thought to a failed request.
      setDraft("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const promote = async (note: NoteRow) => {
    setBusy(note.id);
    try {
      await api.request(`/api/agent/notes/${note.id}/promote`, {});
      // Reload rather than patching the row locally: the server owns the
      // decision, and a promotion that lost a race comes back already promoted.
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (note: NoteRow) => {
    setBusy(note.id);
    try {
      await api.request(`/api/agent/notes/${note.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const ordered = orderedNotes(notes);
  const open = openNoteCount(notes);

  return (
    <View style={{ gap: 18 }}>
      <ErrorNotice error={error} />
      <Card style={{ gap: 10 }}>
        <Text style={s.muted}>
          Jot something down. It sits here until you decide it should be work.
        </Text>
        <Field
          label="New note"
          value={draft}
          onChangeText={setDraft}
          placeholder="What is worth remembering?"
          multiline
        />
        <View style={s.between}>
          <Text style={s.small}>
            {noteTooLong(draft)
              ? "Too long — trim it a little."
              : canSaveNote(draft)
                ? "Ready to save."
                : "A note needs some text."}
          </Text>
          <Button
            small
            primary
            busy={busy === "save"}
            disabled={!canSaveNote(draft) || noteTooLong(draft)}
            onPress={() => void save()}
          >
            Save note
          </Button>
        </View>
      </Card>

      {loading ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <Loader size={22} color={colors.muted} />
        </View>
      ) : ordered.length === 0 ? (
        <Empty
          icon={NotebookPen}
          title="No notes yet"
          detail="Notes are for things you want to hold onto. When one is worth doing, make it a task and it appears on the board."
        />
      ) : (
        <View style={{ gap: 12 }}>
          <Text style={s.small}>
            {open === 0
              ? "Nothing waiting on a decision."
              : `${String(open)} waiting on your decision.`}
          </Text>
          {ordered.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              busy={busy === note.id}
              onPromote={() => void promote(note)}
              onDelete={() => void remove(note)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function NoteCard({
  note,
  busy,
  onPromote,
  onDelete,
}: {
  note: NoteRow;
  busy: boolean;
  onPromote: () => void;
  onDelete: () => void;
}) {
  const action = promotionAction(note);
  return (
    <Card style={{ padding: 15, gap: 10, borderRadius: 18, backgroundColor: "#F7F8F9" }}>
      <View style={{ gap: 4 }}>
        <Text style={s.heading}>{noteHeading(note)}</Text>
        <Text style={s.small}>
          {note.status === "promoted" ? "Promoted" : "Note"} · {relativeDate(note.createdAt)}
        </Text>
      </View>
      <Text style={s.muted}>{note.body}</Text>
      {action && (
        <View style={{ gap: 8 }}>
          <Text style={s.small}>{action.detail}</Text>
          {note.status === "promoted" ? (
            <Text style={[s.small, { color: colors.muted }]}>{action.label}</Text>
          ) : (
            <View style={[s.row, { gap: 8 }]}>
              <Button small primary busy={busy} onPress={onPromote}>
                {action.label}
              </Button>
              <Button small busy={busy} onPress={onDelete}>
                Delete
              </Button>
            </View>
          )}
        </View>
      )}
    </Card>
  );
}
