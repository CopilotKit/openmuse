# openmuse.plugin.json — the plugin manifest convention

Every capability the server offers — connectors today, more tomorrow — is
described by an `openmuse.plugin.json` manifest in its own folder. The
server discovers these manifests at startup, validates them deterministically
(zero model calls), and loads each plugin through a small Hono-native host
API. A manifest is the single source of truth for what a plugin is, what it
provides, how it is configured, and what it is allowed to do.

Reference implementation: `apps/server/src/plugins/` (schema, discovery,
loader, registry, HTTP API). Migrated connectors: `apps/server/src/connectors/credentials/`
and `apps/server/src/connectors/email/`.

## Minimal manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does, in one line.",
  "categories": ["productivity"],
  "activation": "eager",
  "enabledByDefault": true,
  "contracts": {
    "tools": ["my_tool"],
    "routes": { "mountPath": "/api/my-plugin", "paths": ["/"] },
    "channels": [],
    "webSearchProviders": []
  },
  "toolMetadata": {
    "my_tool": { "requiresApproval": false, "kind": "chat", "providedBy": "direct" }
  },
  "configGroups": ["general"],
  "configSchema": {
    "type": "object",
    "properties": {
      "nickname": { "type": "string", "title": "Nickname", "group": "general" }
    }
  },
  "writeOnly": [],
  "skills": [],
  "cliCommands": [],
  "catalog": { "title": "My Plugin", "blurb": "Short catalog copy.", "tags": ["productivity"] },
  "dashboard": { "dataBindings": [], "actionVerbs": [] }
}
```

## Field reference

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9-]*$`, unique across all plugins. |
| `name`, `version`, `description` | yes | Shown in settings and the catalog. |
| `categories` | yes | Non-empty array of lowercase slugs. |
| `activation` | yes | `"eager"` (loaded at startup) or `"lazy"` (loaded on first use). |
| `enabledByDefault` | yes | Whether a fresh owner gets the plugin on. |
| `contracts.tools` | yes | Tool names the plugin offers. Every entry MUST have a `toolMetadata` entry. |
| `contracts.routes` | yes | `mountPath` (must start with `/`) + the route paths the plugin serves. |
| `contracts.channels`, `contracts.webSearchProviders` | yes | Stubs for future capability kinds; empty arrays today. |
| `toolMetadata.<tool>` | yes | `{ requiresApproval, kind: "chat"\|"worker"\|"both", providedBy: "direct"\|"workspace-fallback", description? }`. |
| `configGroups` | yes | Group ids; every group MUST be referenced by at least one `configSchema` property's `group`, and vice versa. |
| `configSchema` | yes | JSON Schema (object) for the plugin's settings. Supported widgets: `password` (secure input), `switch` (boolean toggle), `textarea`, `select` (with `enum`). |
| `writeOnly` | yes | Settings keys that are secrets. MUST be `type: "string"` with `widget: "password"`. Stored AES-256-GCM encrypted; the API always returns `""` for them. |
| `skills` | yes | **Stub for addition #4.** String array; path traversal (`..`, `/`, `\`) is rejected. Nothing consumes it yet. |
| `cliCommands` | yes | Reserved for future CLI exposure; traversal rejected. |
| `catalog` | yes | `{ title, blurb, tags }` for the plugin catalog. |
| `dashboard.dataBindings` | yes | Metadata-only RPC handlers the dashboard may invoke (`POST /api/plugins/:id/invoke`). Each has a `paramShape` (JSON Schema) that params are validated against. |
| `dashboard.actionVerbs` | yes | Reserved verbs for future dashboard actions. |
| `doctorContract` | no | `{ stateMigrations: [{id, description}], configRepair: { dropUnknownKeys } }`. Migrations run once per plugin (bookkept in plugin state); configRepair drops unknown stored keys with a warning instead of failing startup. |

Unknown root keys are rejected — a typo'd field fails loudly at discovery
instead of being silently ignored.

## plugin.ts — the host API

Each plugin folder has a `plugin.ts` exporting `async activate(ctx)`:

```ts
import type { PluginActivation, PluginContext } from "../../plugins/plugin-api.ts";

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  const service = new MyService(ctx.db, ctx.config);
  ctx.registerTools({
    my_tool: {
      chat: (owner) => [defineTool({ name: "my_tool", ... })],
      worker: (host) => host.defineTool("my_tool", "...", schema, execute),
    },
  });
  ctx.registerDataBinding("stats", async (owner, params) => ({ count: 1 }));
  const app = new Hono();
  app.get("/", (c) => c.json({ ok: true }));
  return { service, routes: app };
}
```

The context gives the plugin exactly: `pluginId`, `db` (the store),
`config`, `bindings` (host services like browser/files/google), the
registration functions, `onHook(name, handler)`, and `getConfig(owner)`.
There is deliberately no openclaw Gateway API surface — plugins cannot reach
anything the host does not hand them.

## Validation rules (all deterministic)

- id / tool-name / property-name formats; unknown root keys rejected.
- Every `contracts.tools` entry has a `toolMetadata` entry, and vice versa.
- `configGroups` ↔ schema property `group` cross-check, both directions.
- `writeOnly` keys must exist in the schema, be strings, and use the
  `password` widget.
- **Approval lint:** any tool whose name contains `send`, `fill`, `login`,
  or `delete` MUST declare `requiresApproval: true`, or the manifest is
  refused. (The engine's tool-policy chain gates these tools at runtime; the
  lint keeps a manifest from quietly widening that surface.)
- Path traversal is rejected in `skills` and `cliCommands`.
- The loader additionally verifies that every declared direct tool was
  actually registered by `plugin.ts` (and every declared dataBinding), so a
  manifest cannot claim tools it does not provide.

## Lifecycle

1. **Discovery** scans `apps/server/src/connectors` plus any
   `config.pluginRoots` (`PLUGIN_ROOTS` env). Folders without a manifest are
   ignored. Invalid manifests are *reported* (`GET /api/plugins/errors`) —
   startup never crashes because of a plugin.
2. **Load** imports `plugin.ts`, calls `activate(ctx)`, runs the registration
   checks, then mounts `contracts.routes.mountPath`.
3. **Enablement** is per owner (`PATCH /api/plugins/:id/config { enabled }`).
   Disabled plugins contribute no chat/worker tools and refuse `invoke`.
4. **Doctor** runs declared `stateMigrations` exactly once per plugin, then
   `configRepair` drops unknown stored keys with a warning.
5. **Config** is per owner, schema-validated; unknown keys are rejected (422);
   writeOnly values are encrypted with the existing AES-256-GCM vault and
   always read back as `""`.

## HTTP API (all behind owner auth)

- `GET /api/plugins` — summaries: id, name, version, description,
  categories, enabled, status (`active` | `error`), mountPath, tools,
  writeOnly keys, configGroups, hasConfig.
- `GET /api/plugins/errors` — discovery/load/doctor problems.
- `GET /api/plugins/:id/config` — enabled flag + redacted config + schema.
- `PATCH /api/plugins/:id/config` — `{ enabled?, config? }`; writeOnly `""`
  means "leave the stored secret unchanged".
- `POST /api/plugins/:id/invoke` — `{ binding, params? }`; owner-scoped,
  schema-validated, metadata-only dataBinding RPC.

## Security rules (non-negotiable)

1. Manifests are data, never code: validation is pure and deterministic.
2. Plugin roots containing a `workspace` or `uploads` segment outside the
   server subtree are refused — a dropped manifest + `plugin.ts` there would
   otherwise be `import()`ed.
3. Secrets are write-only end to end: encrypted at rest, `""` in every
   response, never in logs or error messages (validation errors redact
   values).
4. `invoke` is owner-scoped, param-validated, and metadata-only; disabled or
   errored plugins refuse it. Binding results must be JSON-serializable and
   are capped at 256 KB serialized — anything larger or non-serializable is
   a 502, not a truncated guess.
5. The approval lint (send/fill/login/delete ⇒ `requiresApproval: true`)
   keeps risky tool names from slipping past the engine's tool-policy chain.
6. Doctor state migrations never receive the full `Store`: they get a
    per-plugin scoped context (`state.get/put/listOwners` limited to the
    plugin's own `plugin_config` rows plus `getConfig`), so one plugin's
    migration cannot read or write another plugin's state, another owner's
    records, or any other table.
