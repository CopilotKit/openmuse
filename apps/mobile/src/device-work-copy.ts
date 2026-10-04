/**
 * The wording on the device-work card.
 *
 * Split out of `device-work-card.tsx` because that file imports `react-native`,
 * which a `node --test` run cannot load. Same reasoning as `board-model.ts`: text
 * that is only ever visible on a device is text nobody reviews, so it belongs in
 * a module a test can reach.
 */

/** The parts of the loop snapshot the wording depends on. */
export interface StatusSnapshot {
  phase: string;
  enabled: boolean;
  task: { id: string; title: string } | null;
  unpaired: boolean;
  completed: number;
  error: string;
}

/** One line describing what the loop is doing, and what to do about it. */
export function deviceStatusLine(snapshot: StatusSnapshot): string {
  // Pairing outranks every other state, including a task in hand: it is the one
  // thing that unblocks the card. The wording points at the code field rather than
  // restating the instruction, because the card now renders that field directly
  // above this line — saying "pair this device" here read as an instruction the
  // user could not act on, which is exactly the dead end this UI replaced.
  if (snapshot.unpaired) return "Enter the code from a device you already trust.";
  if (snapshot.task) return `Working on ${snapshot.task.title}`;
  if (!snapshot.enabled) return "Off. This device is not picking up work.";
  if (snapshot.phase === "running") return "Finishing up…";
  if (snapshot.phase === "claiming") return "Looking for work…";
  return "On. Waiting for work this device can run.";
}

/**
 * `snapshot.error`, filtered.
 *
 * The loop records a reason on every empty claim, and `no-eligible-work` is the
 * normal answer several times an hour rather than anything actionable — showing
 * it would train the user to ignore this card, which is how a real notice stops
 * being read.
 */
export function visibleError(error: string): string {
  if (!error) return "";
  // Tolerates `no-eligible-work` and `No eligible work`: the server sends the
  // hyphenated form today, and this is a display filter — it should not start
  // showing noise because a reason string was reworded.
  if (/no[- ]eligible[- ]work/i.test(error)) return "";
  return error;
}
