#!/usr/bin/env bash
# Mutation check for the device work loop.
#
# A test that passes both with and without the guard is not evidence the guard
# works. Each mutation below removes one control and the suite MUST fail
# (MUTATION_KILLED). Any that survives is a real gap in the tests.
#
# The backup path is FIXED, never mktemp: TMPDIR is the Hermes scratch dir,
# which can be pruned mid-script and would leave a mutation applied to the tree.
set -uo pipefail
cd "$(dirname "$0")/.."

LOOP="apps/mobile/src/device-agent-loop.ts"
BAK="/tmp/openmuse-device-loop.bak.ts"
cp "$LOOP" "$BAK" || exit 1

restore() { cp "$BAK" "$LOOP"; }
trap restore EXIT

# Runs both suites and echoes TOTAL_PASS/TOTAL_FAIL.
#
# The counts are SUMMED across the two suites rather than matched as text. An
# earlier version piped them through `tr '\n' ' '`, which put both suites' output
# on one line so `grep '^# fail 0'` could never match — every mutation then read
# as killed, including ones that plainly survived. The lesson from the pairing
# work applies here too: an assertion that cannot fail is not an assertion.
run_suite() {
  local out
  out=$(npx tsx --test apps/mobile/test/device-agent-loop.test.ts tests/device-loop-e2e.test.ts 2>&1)
  local pass fail
  pass=$(echo "$out" | awk '/^# pass [0-9]/ {s+=$3} END {print s+0}')
  fail=$(echo "$out" | awk '/^# fail [0-9]/ {s+=$3} END {print s+0}')
  # A suite that fails to even load reports neither counter; treat that as a
  # failure rather than a pass, or a broken mutation would look like a clean kill.
  if [ "$pass" -eq 0 ]; then
    echo "pass=0 fail=unknown"
    return
  fi
  echo "pass=$pass fail=$fail"
}

mutate() {
  local label="$1" old="$2" new="$3"
  restore
  if ! grep -qF "$old" "$LOOP"; then
    echo "STALE_ANCHOR $label -- UNPROVEN (anchor not found; not applied)"
    return 3
  fi
  python3 - "$LOOP" "$old" "$new" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = pathlib.Path(path).read_text()
# Anchor check and mutation in one step: a separate grep would treat each line
# of a multi-line anchor as its own pattern and report a false hit.
if s.count(old) != 1:
    print(f"ANCHOR_AMBIGUOUS ({s.count(old)} matches)", file=sys.stderr)
    sys.exit(3)
pathlib.Path(path).write_text(s.replace(old, new))
PY
  if [ $? -ne 0 ]; then
    echo "STALE_ANCHOR $label -- UNPROVEN (mutation not applied)"
    return 3
  fi
  local result
  result=$(run_suite)
  case "$result" in
    *"fail=0"*)
      # A survivor is not automatically a test gap: it may be an equivalent
      # mutant, which is recorded in the label above. Anything else is a real gap.
      case "$label" in
        *equivalent*) echo "EQUIVALENT_MUTANT $label  ($result)" ;;
        *)            echo "MUTATION_SURVIVED $label  ($result)" ;;
      esac
      ;;
    *) echo "MUTATION_KILLED   $label  ($result)" ;;
  esac
}

echo "baseline: $(run_suite)"

mutate "abort on lost lease" \
  '    if (!ok) {
      active.controller.abort();' \
  '    if (!ok) {
      schedule();
      return;'

mutate "silent on aborted run" \
  '      this.finishRun();
      return;
    }
    await this.reportRun(' \
  '      this.finishRun();
      return;
    }
    await this.reportRun2('

mutate "report after losing the lease" \
  '    if (active.controller.signal.aborted) {' \
  '    if (false) {'

mutate "treat a lost lease as a failure" \
  '      if (isLostLease(e)) {' \
  '      if (false) {'

mutate "stop heartbeating after a network error" \
  '      this.setError("Lost contact with your workspace; still holding the task.");
      schedule();
      return;' \
  '      this.setError("Lost contact with your workspace; still holding the task.");
      return;'

mutate "heartbeat against the original lease window" \
  '    if (leaseUntil) active.leaseUntil = leaseUntil;' \
  '    if (false) active.leaseUntil = leaseUntil;'

# Re-arming after `stop()` is the property that keeps a paused loop from polling.
mutate "re-arm the poll after stop" \
  '    if (this.isEnabled() && this.phase !== "running")' \
  '    if (this.phase !== "running")'

# EQUIVALENT MUTANT, deliberately not asserted as killed. Re-arming the poll at the
# TOP of tick() looks like it would let two ticks overlap, but `schedulePoll` chains
# onto `tickChain`, so the second tick still waits for the first to settle. Both
# mechanisms were read before recording this; defending the mutant with a test would
# be asserting a property the code does not provide.
mutate "eagerly re-arm the poll (equivalent: tickChain serialises anyway)" \
  '  private async tick() {
    if (!this.isEnabled()) return;' \
  '  private async tick() {
    this.schedulePoll(nextIdleDelay(this.idleStreak, this.timing));
    if (!this.isEnabled()) return;'

mutate "hide the pairing gate" \
  '  return /pair/i.test(messageOf(error));' \
  '  return false;'

mutate "no idle backoff" \
  '  return Math.min(timing.idlePollMs * 2 ** consecutiveIdle, timing.maxIdlePollMs);' \
  '  return timing.idlePollMs;'

mutate "let a short lease produce a tiny heartbeat" \
  '  return Math.max(Math.floor(window * timing.heartbeatFraction), timing.minHeartbeatMs);' \
  '  return Math.floor(window * timing.heartbeatFraction);'

# The pairing list. Kept separate because it guards a DIFFERENT file: without
# `paired` on `/devices`, the approval UI has no target and a second phone can
# never be paired at all.
PAIRS="apps/server/src/engine/service.ts"
PAIRS_BAK="/tmp/openmuse-device-pairs.bak.ts"
cp "$PAIRS" "$PAIRS_BAK" || exit 1
restore_pairs() { cp "$PAIRS_BAK" "$PAIRS"; }
trap 'restore; restore_pairs' EXIT

mutate_pairs() {
  local label="$1" old="$2" new="$3"
  restore_pairs
  python3 - "$PAIRS" "$old" "$new" <<'PY2'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = pathlib.Path(path).read_text()
if s.count(old) != 1:
    print(f"ANCHOR_AMBIGUOUS ({s.count(old)} matches)", file=sys.stderr)
    sys.exit(3)
pathlib.Path(path).write_text(s.replace(old, new))
PY2
  if [ $? -ne 0 ]; then
    echo "STALE_ANCHOR $label -- UNPROVEN (mutation not applied)"
    return 3
  fi
  local result
  result=$(npx tsx --test tests/device-loop-e2e.test.ts 2>&1 | awk '/^# pass [0-9]/ {p+=$3} /^# fail [0-9]/ {f+=$3} END {print "pass=" p+0 " fail=" f+0}')
  case "$result" in
    *"fail=0"*) echo "MUTATION_SURVIVED $label  ($result)" ;;
    *)          echo "MUTATION_KILLED   $label  ($result)" ;;
  esac
}

# Anchored on the whole `devices()` body, NOT the `paired:` line alone: an
# identical expression appears in `runnableOn`, and a single-line anchor would
# mutate whichever came first — reporting a gap that is really a bad anchor.
mutate_pairs "hide pairing from the device list" \
  '        paired: (await this.db.pairingState(owner, device.id)).pairedAt !== null,
      })),
    );
  }' \
  '        paired: true,
      })),
    );
  }'

restore
restore_pairs
echo "restored"
git diff --stat "$LOOP"