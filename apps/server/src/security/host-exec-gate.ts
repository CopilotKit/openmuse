/**
 * Composed gate for the OpenMuse routes that execute processes on the server's
 * host or inside a container it owns.
 *
 * LIFTED from cntrl `src/lib/security/hostExecGate.ts`, which in turn builds on
 * its `scopeGate` and `local-endpoints`. The principle that survived the lift:
 * **a route names the SURFACE it is, never the policy it needs.** The required
 * control is looked up from the table below, so a new execution route cannot be
 * wired up with an unstated policy — adding a member to `HostExecSurface`
 * without adding its row is a compile error, which is the entire point.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ADAPTED, AND WHY THE ADAPTATION IS THE POINT
 * ---------------------------------------------------------------------------
 * cntrl gates on an ACCESS SCOPE (`read`/`write`/`admin`) read off a
 * self-asserted header, and its own header says plainly that with its default
 * configuration the scope half adds no boundary at all — the origin control is
 * doing the work. Copying a scope table here would have imported a paper
 * control: OpenMuse has no scopes, and inventing one to justify the lift would
 * be a control that looks real and gates nothing.
 *
 * So the keyed dimension here is the one OpenMuse actually has and can enforce:
 *
 *   - `host-exec` surfaces run a process on the server host or in a container
 *     it started (`docker exec`, container lifecycle). These get BOTH browser
 *     controls, because the ambient credentials a browser holds for this
 *     origin would otherwise be enough to run a shell.
 *   - `guarded` surfaces do not execute anything but do act on stored state
 *     with real-world effect (sending mail). These get the cross-site control
 *     only; their bodies are JSON, but they are reached from the mobile client
 *     with a multipart-adjacent shape in places, and the CORS-simple rule is
 *     scoped to the JSON execution surfaces where it is provably true.
 *
 * Every surface still passes through `Auth.session`/`Auth.device` in `app.ts`.
 * This gate does not replace authentication and is not a substitute for it: it
 * answers "may a request that reached an authenticated session have been
 * manufactured by a page on another site", which authentication cannot answer.
 */

import { isBrowserDrivenRequestAllowed } from "./request-origin.ts";

/**
 * The execution surfaces. A member added here without a row in
 * {@link HOST_EXEC_CONTROLS} fails to compile.
 */
export type HostExecSurface =
  // --- process execution on the host or in a container this server owns ---
  | "computer.start"
  | "computer.stop"
  | "computer.command"
  | "computer.file"
  | "computer.desktop"
  | "browser.session"
  | "browser.input"
  // --- state with real-world effect, no process execution ---
  | "action.decide"
  | "chat.dispatch";

/** Which browser-driven-request controls a surface is held to. */
export interface SurfaceControls {
  /** Reject a request a page on another site issued. */
  crossSite: boolean;
  /**
   * Reject a CORS-simple write. Only sound on surfaces whose body is parsed as
   * JSON — see the module header for why it is not applied globally.
   */
  corsSimpleWrite: boolean;
}

/**
 * Required controls per surface. THIS TABLE IS THE POLICY.
 *
 * The reasoning behind each row:
 *
 * - `computer.*` — `docker exec /bin/bash -c <command>` with an
 *   operator-influenced argv, under the server's identity. A shell is a strict
 *   superset of everything the product's own data can do, so it is held to both
 *   controls. `computer.file` reaches the same process through a different
 *   call, and `computer.desktop` drives a real desktop's input, so neither gets
 *   a weaker row than `computer.command`.
 * - `browser.session` — opens a session in the browser worker at an
 *   operator-or-model-supplied URL. It is not host process execution (the worker
 *   is a separate container with its own SSRF guard), but it is driven by a URL
 *   a chat turn can influence, so it is held to the same controls as a command.
 * - `browser.input` — injects clicks and keystrokes into that session.
 *   Reachable only by session id, and it acts on the user's own screen.
 * - `action.decide` — approves a proposal that can send real mail. No process
 *   execution, so the CORS-simple rule does not apply; the cross-site control
 *   does, because the effect is irreversible from the product's side.
 * - `chat.dispatch` — the agent turn itself, which can reach any tool the
 *   allowlist permits, including the computer. Held to both.
 */
export const HOST_EXEC_CONTROLS: Record<HostExecSurface, SurfaceControls> = {
  "computer.start": { crossSite: true, corsSimpleWrite: true },
  "computer.stop": { crossSite: true, corsSimpleWrite: true },
  "computer.command": { crossSite: true, corsSimpleWrite: true },
  "computer.file": { crossSite: true, corsSimpleWrite: true },
  "computer.desktop": { crossSite: true, corsSimpleWrite: true },
  "browser.session": { crossSite: true, corsSimpleWrite: true },
  "browser.input": { crossSite: true, corsSimpleWrite: true },
  "action.decide": { crossSite: true, corsSimpleWrite: false },
  "chat.dispatch": { crossSite: true, corsSimpleWrite: true },
};

/** The headers and method the verdict needs; Hono's request satisfies this. */
export interface GateRequest {
  headers: { get(name: string): string | null };
  method?: string | undefined;
}

export type GateOutcome = { refused: false } | { refused: true; reason: string; status: 403 };

/**
 * Decide whether `surface` may proceed. Returns a value rather than throwing:
 * a refusal must read to the caller as a policy decision, not a 500.
 *
 * Fails CLOSED on an unknown surface. The `Record` type makes that a compile
 * error for a caller that names a literal, so reaching it requires a cast —
 * which is the point of failing closed rather than defaulting to "allowed".
 */
export function hostExecGate(
  request: GateRequest | null | undefined,
  surface: HostExecSurface,
): GateOutcome {
  const controls = HOST_EXEC_CONTROLS[surface];
  if (!controls) return { refused: true, reason: `unknown surface: ${surface}`, status: 403 };
  if (!request) return { refused: true, reason: "no request context", status: 403 };

  const verdict = isBrowserDrivenRequestAllowed(request, controls);
  if (!verdict.allowed) return { refused: true, reason: verdict.reason, status: 403 };
  return { refused: false };
}
