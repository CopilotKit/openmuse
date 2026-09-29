# Mobile Model Routing Settings

## Architecture

The server reads CHAT_MODEL, TASK_MODEL, SIMPLE_TASK_MODEL, and step limits
from env vars. The mobile app discovers the server config via GET /api/agent/models
and can set per-device overrides via PATCH /api/agent/device-models.

## Domain Types

Defined in packages/domain/src/agent.ts:

- ModelRoutingInfo: read-only server config (chatModel, taskModel, simpleTaskModel,
  maxSteps, simpleTaskKinds, chatToolAllowlist)
- DeviceModelRouting: per-device override (chatModel?, taskModel?, simpleTaskModel?,
  chatMaxSteps?, taskMaxSteps?, simpleTaskMaxSteps?, chatToolAllowlist?)
  Re-exported from packages/domain/src/index.ts for both server and mobile.

## Server Endpoints

### GET /api/agent/models
Returns modelInfo(config) from apps/server/src/agent.ts with fallback chaining
(taskModel ?? model ?? chatModel ?? undefined). Now includes chatToolAllowlist.

### GET /api/agent/available-models
New endpoint in apps/server/src/engine/routes.ts. Returns:
```json
{
  "providers": { "openai": <bool>, "google": <bool> },
  "models": { "chat": "...", "task": "...", "simpleTask": "..." },
  "chatToolAllowlist": ["delegate_task", "agent_status", ...]
}
```
Used by the mobile UI to show which providers are active and which model
names the server defaults to.

### GET/PATCH /api/agent/device-models
Located in apps/server/src/engine/routes.ts. Requires deviceId session.
- GET: reads agent-settings DB entry keyed device-models:${deviceId}, returns {}
- PATCH: writes { id, ...body } to agent-settings with Zod validation

Uses c.get("device") from auth middleware. Returns 400 if deviceId is null.
The PATCH schema validates step overrides with z.number().int().positive().optional().
The PATCH schema also accepts chatToolAllowlist: z.array(z.string().min(1)).max(100).optional().

Pitfall: The PATCH schema uses POST method override — the `request()` helper
in tests defaults to POST, so device PATCH calls need an explicit method:"PATCH".

## Mobile Device Identity

apps/mobile/src/device.ts: deviceInfo() is now async, using expo-secure-store
to persist a randomUUID across app restarts on native platforms.
- deviceId(): first launch generates UUID, persists to SecureStore; subsequent
  calls return the cached value. Web falls back to localStorage.
- deviceName(): returns Platform.OS-derived label ("iOS companion", etc.)
- deviceInfo(): async wrapper returning { deviceId, deviceName }

App.tsx awaits deviceInfo() inside the async connect() callback and passes
the result to createSession(key, await deviceInfo()).

Web platform persists the UUID to `localStorage` (not just in-memory) so the
same device identity survives page reloads. The device.ts module branches on
`Platform.OS === "web"` before any SecureStore call and uses
`localStorage.getItem`/`setItem` instead. Native platforms still use
expo-secure-store.

Pitfall: expo-secure-store is async and unavailable on web. Always branch on
Platform.OS === "web" before calling SecureStore methods. The web fallback
should persist via localStorage, not just in-memory — page reloads must
preserve the same deviceId.

Pitfall: adding a native Expo module to a pnpm monorepo requires updating
THREE places — `pnpm add -w <pkg>` updates the root workspace, but the
mobile app's own `apps/mobile/package.json` still needs the dependency
entry, and `npm install <pkg>` in `apps/mobile` is needed for the native
build artifacts. Skipping the mobile-level install causes
"Module not found: Can't resolve 'expo-secure-store'" at build time,
even though the root package.json has it.

Pitfall: createSession must receive device info at session creation time
(PATCH /api/session). Device routing is keyed by deviceId stored on the session,
not inferred later. Missing deviceId at session creation means all device-models
API calls will return 400.

Pitfall: numeric step override fields in ModelRoutingSection use
keyboardType="numeric" and convert to Number() before saving. Empty strings
map to undefined (falls back to server default). Zod validates with
z.number().int().positive().optional().

Pitfall: also validate step inputs CLIENT-SIDE before sending to the server.
Check `Number.isInteger(n) && n > 0` before calling save(). Without this,
a user can type "0" or "3.5" and the error only surfaces after a wasted
network round-trip — the PATCH endpoint returns 422 but the form stays in
editing mode with no inline error. Use a local `localError` state (not the
hook's `overrideError`) to surface validation failures inline before any
network request is made.

### Clearing overrides

Add a "Clear all overrides" button that resets all `useState` fields
(`setChatModel("")`, `setTaskModel("")`, etc.) and then calls `save({})`
to send an empty object to the server (PATCH with empty body resets all
overrides to server defaults). Disable the button while saving or loading.
The disabled condition must include ALL override fields, including
`toolAllowlist` — otherwise the button stays enabled after clearing and
clicking it triggers a redundant empty PATCH.

## Mobile Hooks

apps/mobile/src/model-routing.ts. Both use useWorkspace() for api context.
- useModelRouting(): GET /api/agent/models, returns { data, error, refresh }
- useAvailableModels(): GET /api/agent/available-models, returns { data, error, refresh }
  Returns AvailableModels interface (providers, models, chatToolAllowlist)
- useDeviceModelRouting(): GET/PATCH /api/agent/device-models, returns
  { overrides, error, loaded, save }. save() does PATCH then refreshWorkspace()

## Mobile UI

ModelRoutingSection in apps/mobile/src/agent-ui.tsx renders in the Apps screen.
Shows server config (read-only) and editable device override fields.

The UI includes:
- Server config display: model names + step budgets (read-only, from useModelRouting)
- Chat tool allowlist display: server-wide allowlist from /models endpoint (read-only)
- Device overrides form: chat/task/simple model fields, step budget fields, tool allowlist field
- Step budget validation: client-side checks for positive integers before save()
- Save button: disabled until at least one override field is filled
- Clear all overrides button: resets all state + sends empty PATCH
- Status Chip: "Overrides active" (green) vs "Using server defaults" (gray)
- ErrorNotice: shows localError || routingError || overrideError

Pitfall: SettingsLine is defined inside ConnectionsScreen in screens.tsx and NOT
exported. ModelRoutingSection reimplements the layout inline with View+Text.
Do not import local functions.

Pitfall: Use routing.chatToolAllowlist.length > 0 for conditional rendering,
not !!routing.chatToolAllowlist.length (Biome useExplicitLengthCheck is error).

### Per-device tool allowlist

The chatToolAllowlist field lets a small mobile model (3B-9B) receive only a
subset of tools, while the desktop model gets the full set. The input is
comma-separated (e.g. "delegate_task,agent_status,computer_*").
- Empty string → undefined (falls back to server-wide CHAT_TOOL_ALLOWLIST)
- Parsed with split(",") → trim() → filter(Boolean) before sending to server
- Server validates with z.array(z.string().min(1)).max(100).optional()
- ConversationAgent.run() applies deviceOverrides?.chatToolAllowlist ??
  config.chatToolAllowlist, so a mobile device can restrict to e.g.
  delegate_task + agent_status only

Pitfall: The tool allowlist override only applies to the CHAT path
(ConversationAgent). Task worker tools are always the full set — the tool
allowlist concept doesn't apply there since the task model is expected to
be a larger model.

## Routing Integration (Server-Side)

Overrides read at the routing decision point, not at task creation.
Tasks carry state.creatorDevice.deviceId (set in service.ts createTask).
Chat agent carries this.device.deviceId (from session auth).

### Task routing: apps/server/src/engine/model.ts
selectTaskModel(config, task, deviceOverrides?) accepts an optional third arg.
When provided, deviceOverrides.taskModel/simpleTaskModel override server config
for that task kind. Step overrides are also honored:
deviceOverrides?.simpleTaskMaxSteps ?? config.simpleTaskMaxSteps ?? 6.

executeModelTask() fetches overrides before calling selectTaskModel:
- Reads state.creatorDevice (typed as Record<string, unknown>)
- Cast: (state.creatorDevice as { deviceId?: string } | undefined)?.deviceId
- Fetches DeviceModelRouting from DB by key device-models:${deviceId}
- db.get<T>() returns T | null | undefined; coalesce ?? undefined

### Chat routing: apps/server/src/engine/conversation.ts
ConversationAgent.run() fetches device override inside the agentPromise
(the async IIFE), because deviceOverrides is needed for both model selection
AND tool allowlist filtering. The fetch happens AFTER the tools array is
defined but BEFORE tanstackAgent() is called:

```
const agentPromise = (async () => {
  const deviceOverrides = await db.get<DeviceModelRouting>(...);
  const allowlist = deviceOverrides?.chatToolAllowlist ?? config.chatToolAllowlist;
  const effectiveTools = filterTools(tools, allowlist);
  return tanstackAgent({ model: ..., maxSteps: ..., tools: effectiveTools });
})();
```

This means the tool filtering is async — the tools array is built synchronously,
then filterTools runs inside the async wrapper. This is fine because the Observable
subscribes to agentPromise and doesn't start running until the agent is resolved.

Pitfall: When refactoring from sync to async Observable setup (fetch DB before
creating agent), use subscriber.add(() => {...}) for teardown instead of
return () => {...}. The sync return runs before the async agent exists.

### Step budget overrides
DeviceModelRouting now includes chatMaxSteps, taskMaxSteps, simpleTaskMaxSteps.
These are honored in selectTaskModel() and ConversationAgent.run(), falling back
to server config when not set.

### Tool allowlist overrides
DeviceModelRouting includes chatToolAllowlist (string[]). Honored in
ConversationAgent.run() via filterTools(). Task worker does not use device
tool allowlist — the task model is always given the full tool set.

## Tests

Unit (tests/model-routing.test.ts): 10 tests
- 4 selectTaskModel device override tests (priority, fallback, undefined, step override)
- 6 filterTools tests (undefined, empty, exact, prefix glob, wildcard, mixed)

Integration (tests/agent-api.test.ts): 4 routing tests
- device-models round-trip (chatModel, taskModel, chatMaxSteps: 3)
- PATCH rejects invalid step budgets (negative, zero, non-integer, 422 response)
- available-models endpoint reports provider availability
- chatToolAllowlist override round-trips through PATCH + GET

Pitfall: To test a config variation (e.g. chatToolAllowlist), create a separate
app instance with createApp(db, {...config, ...override}) - the Hono auth
middleware reads config at startup. Clean up with finally { await app.stop() }.

Pitfall: When reading back a POST response for assertions, use
JSON.parse(await response.clone().text()) since response.json() consumes the body.
Cast creatorDevice since state is Record<string, unknown>.

Pitfall: When testing an endpoint that requires a device session, create a
session with { deviceId: "test-001" } in the POST /api/session body. The session
middleware stores deviceId from the request body. A session without deviceId
will get 400 on /device-models.

## Pre-existing Test Failures

device-streaming.test.ts tests fail with 409 task limit when run alongside
other tests sharing PostgreSQL. NOT caused by routing changes - confirmed against
pre-routing commit. Cross-test data accumulation in shared PostgreSQL DB.
