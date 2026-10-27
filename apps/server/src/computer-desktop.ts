import { z } from "zod";
import { computerOutputLimit } from "./computer.ts";

// What every desktop provider shares: the screen, the action the agent sends, and
// the in-box command wrapper. Each provider maps an action onto its own input.

export const resolution: [number, number] = [1280, 800];
// In-box temp files for one command's output are capped here (see desktopCommand).
const diskCeiling = 32 * 1024 * 1024;
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** In-box wrapper for one terminal command, with the same 30 second limit as Docker.
 * Output goes to temporary files, so a background GUI app (`firefox-esr URL &`)
 * cannot hold the output stream open after the shell exits. A watchdog stops the
 * command once those files pass `ceiling` bytes, so a runaway writer cannot fill the disk. */
export function desktopCommand(
  command: string,
  limit = computerOutputLimit,
  ceiling = diskCeiling,
) {
  return `/bin/bash --noprofile --norc -c ${quote(desktopScript('"$1"', limit, ceiling))} openmuse ${quote(command)}`;
}

/** The wrapper's script; `commandRef` is the shell word that expands to the command. */
export function desktopScript(
  commandRef: string,
  limit = computerOutputLimit,
  ceiling = diskCeiling,
) {
  return [
    // fd 3 is the real stderr; bash's own job notices go to /dev/null.
    "exec 3>&2 2>/dev/null",
    "o=$(mktemp -d) || exit 125",
    `/usr/bin/timeout --signal=TERM --kill-after=2s 30s /bin/bash --noprofile --norc -c ${commandRef} >"$o/out" 2>"$o/err" </dev/null 3>&- &`,
    "p=$!",
    `{ while kill -0 $p 2>/dev/null; do [ $(( $(wc -c <"$o/out") + $(wc -c <"$o/err") )) -gt ${ceiling} ] && { : >"$o/big"; kill $p; break; }; sleep 0.1; done; } </dev/null >/dev/null 2>&1 3>&- &`,
    "w=$!",
    "wait $p",
    "s=$?",
    "kill $w 2>/dev/null",
    // Sent first: the server's output cap is shared, and stdout alone can fill it.
    `[ -e "$o/big" ] && printf 'Output exceeded the limit; the command was stopped.\\n' >&3`,
    `head -c ${limit + 1} "$o/out"`,
    `head -c ${limit + 1} "$o/err" >&3`,
    'rm -rf "$o"',
    "exit $s",
  ].join("\n");
}

// One GUI action, shaped like Anthropic's computer-use tool. Coordinates are native
// screenshot pixels; the screen is `resolution` wide and high.
export const desktopActionSchema = z
  .object({
    action: z.enum([
      "screenshot",
      "left_click",
      "double_click",
      "right_click",
      "mouse_move",
      "type",
      "key",
      "scroll",
      "wait",
    ]),
    coordinate: z
      .array(z.number().int().min(0))
      .length(2)
      .optional()
      .describe("[x, y] in screenshot pixels. Clicks and scroll without it use the pointer"),
    text: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Text for type; for key, xdotool key names or combos such as Return or ctrl+l"),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().int().min(1).max(15).optional().describe("Wheel clicks, default 3"),
    duration: z.number().min(0.1).max(10).optional().describe("Seconds to wait, default 1"),
  })
  .superRefine((value, ctx) => {
    const need = (field: "coordinate" | "text" | "scroll_direction", present: boolean) => {
      if (!present)
        ctx.addIssue({ code: "custom", path: [field], message: `${value.action} needs ${field}` });
    };
    if (value.action === "mouse_move") need("coordinate", !!value.coordinate);
    if (value.action === "type" || value.action === "key") need("text", !!value.text);
    if (value.action === "scroll") need("scroll_direction", !!value.scroll_direction);
    if (value.action === "key" && value.text && !/^[A-Za-z0-9_+ -]+$/.test(value.text))
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Use xdotool key names, e.g. ctrl+l",
      });
    const [x = 0, y = 0] = value.coordinate ?? [];
    if (x >= resolution[0] || y >= resolution[1])
      ctx.addIssue({
        code: "custom",
        path: ["coordinate"],
        message: `The screen is ${resolution.join("x")}`,
      });
  });
export type DesktopAction = z.infer<typeof desktopActionSchema>;

/** Receipt line for an action, e.g. `desktop left_click (640, 400)`. */
export function describeDesktopAction(action: DesktopAction) {
  return [
    "desktop",
    action.action,
    action.coordinate && `(${action.coordinate.join(", ")})`,
    action.text && JSON.stringify(action.text.slice(0, 200)),
    action.scroll_direction && `${action.scroll_direction} ${action.scroll_amount ?? 3}`,
    action.action === "wait" && `${action.duration ?? 1}s`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** One action's screenshot. `uncertain` means the input may or may not have run. */
export interface DesktopShot {
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  image: Uint8Array;
  uncertain: boolean;
  warning?: string;
}

/** A provider's graphical desktop, used by ComputerService for use_desktop and the Desktop tab. */
export interface ComputerDesktop {
  /** A browser URL for the live desktop; `firstConnect` serializes a first attach with lifecycle changes. */
  desktopUrl(
    labels: Record<string, string>,
    firstConnect?: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<string>;
  /** Perform one action and return the screenshot after it. `beforeInput` runs before any input is sent. */
  act(
    labels: Record<string, string>,
    action: DesktopAction,
    beforeInput?: () => Promise<void>,
  ): Promise<DesktopShot>;
}
