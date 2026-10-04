#!/usr/bin/env bash
# Prove the note-promotion rules are real, by removing each and requiring a failure.
#
# Same discipline as scripts/mutation-device-loop.sh: a green suite only means
# something if a mutant fails it. Each control below is deleted in turn; every
# one MUST kill at least one test, or the harness exits non-zero.
#
# The anchor check and the patch are done in ONE python step. `grep -F` on a
# multi-line block treats each line as a separate pattern (an OR), so it reports
# "found" when only one line matches — and without `set -e` a never-applied
# mutation then reads as a SURVIVOR rather than an error.
#
# Targets are backed up to a FIXED /tmp path with `cp`, never `mktemp`: TMPDIR is
# the Hermes scratch dir, which can be pruned mid-script and leave a mutation
# applied to the working tree.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
BACKUP=/tmp/om-notes-backup
rm -rf "$BACKUP" && mkdir -p "$BACKUP"
FILES=(packages/domain/src/note.ts apps/server/src/engine/service.ts apps/server/src/engine/routes.ts apps/mobile/src/notes-model.ts)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

pass=0; fail=0

# Refuse to run against a dirty tree.
#
# The backup below is taken from whatever is on disk, so a mutation left applied
# by an earlier run (or by a hand edit) becomes the baseline for this one — and
# every result afterwards is measured against the wrong file. That is not a
# hypothetical: it is how a stale anchor here once left `z.string()` sitting in
# the promotion route and reported the control as merely unproven. For tracked
# files the check is exact; untracked ones (note.ts, notes-model.ts are new) are
# simply backed up as-is.
dirty=$(git status --porcelain -- "${FILES[@]}" 2>/dev/null | grep -v '^??' || true)
if [ -n "$dirty" ]; then
  echo "REFUSING: tracked targets have uncommitted changes. Commit or stash first:"
  echo "$dirty"
  exit 1
fi

# mutate <label> <file> <old> <new>
mutate() {
  local label="$1" file="$2" old="$3" new="$4"
  restore
  if ! python3 - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if old not in text:
    sys.stderr.write("STALE_ANCHOR — mutation never applied, result UNPROVEN\n")
    sys.exit(3)
open(path, "w").write(text.replace(old, new, 1))
PY
  then
    echo "UNPROVEN  $label (anchor missed)"
    fail=$((fail+1)); return
  fi
  # Compare against the backup, NOT `git diff`. Two of the targets are new
  # untracked files, and git reports no diff for those even when the bytes
  # changed — which would make every mutation on them look like a no-op and
  # silently mark real controls UNPROVEN.
  if cmp -s "$BACKUP/$(basename "$file")" "$file"; then
    echo "UNPROVEN  $label (patch was a no-op)"
    fail=$((fail+1)); return
  fi
  local out
  out=$(npx tsx --test packages/domain/test/note.test.ts tests/notes-api.test.ts \
          apps/mobile/test/notes-model.test.ts 2>&1)
  # Inspect each suite's OWN `# fail` line rather than collapsing the output with
  # `tr`. Collapsing is the bug this harness exists to catch elsewhere: it hides
  # a non-zero counter behind a mangled line, so `grep '^# fail 0'` misses and
  # every mutation — survivors included — reads as killed.
  if printf '%s' "$out" | grep -qE '^# fail [1-9]'; then
    echo "KILLED    $label"
    pass=$((pass+1))
  elif printf '%s' "$out" | grep -q '^# tests 0$'; then
    echo "NO-SUITE  $label (suite failed to load — a failure, not a pass)"
    fail=$((fail+1))
  else
    echo "SURVIVED  $label  <-- the control is not exercised"
    fail=$((fail+1))
  fi
}

mutate "promotion ignores an already-promoted note" \
  packages/domain/src/note.ts \
  'if (note.status === "promoted")' \
  'if (false)'

mutate "an empty note is treated as promotable" \
  packages/domain/src/note.ts \
  'const prompt = note.body.trim();
  if (!prompt)' \
  'const prompt = note.body.trim();
  if (false)'

mutate "promotion uses a random task id instead of the derived one" \
  apps/server/src/engine/service.ts \
  '      `note:${id}`,' \
  '      undefined,'

mutate "promotion does not claim the note first" \
  apps/server/src/engine/service.ts \
  'if (!claimed) return { note, taskId: this.noteTaskId(note), alreadyPromoted: true };' \
  'if (!claimed) return { note, taskId: null, alreadyPromoted: true };'

mutate "a promoted note can be deleted" \
  apps/server/src/engine/service.ts \
  'if (note.status === "promoted") {' \
  'if (false) {'

mutate "an unknown promotion kind is accepted anyway" \
  apps/server/src/engine/routes.ts \
  '.object({ kind: createTaskSchema.shape.kind.optional() })' \
  '.object({ kind: z.string().optional() })'

mutate "the client offers promotion on an empty note" \
  apps/mobile/src/notes-model.ts \
  'if (!note.promotable || !note.body.trim()) return null;' \
  'if (!note.promotable) return null;'

mutate "promoted notes are sorted first instead of last" \
  apps/mobile/src/notes-model.ts \
  'return a.status === "promoted" ? 1 : -1;' \
  'return a.status === "promoted" ? -1 : 1;'

restore
echo
echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]