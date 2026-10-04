/**
 * Hono binding for the host-exec gate.
 *
 * Kept in its own module rather than exported from `app.ts` so the route files
 * can apply it without importing the app that mounts them — `app.ts` imports
 * `computer-routes.ts`, so a reverse import would be a cycle, and the repo lints
 * `noImportCycles` as an error.
 */
import type { Context } from "hono";
import { type HostExecSurface, hostExecGate } from "./host-exec-gate.ts";

/**
 * Apply the host-exec gate to a route. Each call site names its SURFACE and the
 * gate's table decides the controls that surface is held to, so a route cannot
 * be wired up with a policy weaker than policy allows.
 *
 * Refusals return 403 with the reason. They do not throw: a refusal must read
 * to the caller as a policy decision, not as a 500.
 */
export function gated(surface: HostExecSurface) {
  // The path-param generic is `string` rather than a literal so Hono still infers
  // each route's params from its own path.
  return async (c: Context<object, string>, next: () => Promise<void>) => {
    const outcome = hostExecGate({ headers: c.req.raw.headers, method: c.req.method }, surface);
    if (outcome.refused) return c.json({ error: `Refused: ${outcome.reason}` }, outcome.status);
    await next();
    // biome-ignore lint/complexity/noUselessReturn: needed for noImplicitReturns
    return;
  };
}
