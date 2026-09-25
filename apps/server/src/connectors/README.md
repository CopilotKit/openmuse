# Connectors

Each connector lives in its own folder under `apps/server/src/connectors/`.
A connector is a self-contained integration: it owns its storage records,
its HTTP routes, its agent tools, and its README. Nothing outside the folder
reaches into a connector's internals; wiring happens only through the
small public surface each connector exports.

## Folder layout

```
connectors/
  README.md            # this file: how connectors are organized and managed
  credentials/
    README.md          # setup, capabilities, security, lifecycle
    openmuse.plugin.json  # the plugin manifest (see docs/plugin-manifest.md)
    plugin.ts          # activate(ctx): registers tools, routes, service
    schemas.ts         # zod validation for every external input
    service.ts         # business logic + encrypted secret access
    routes.ts          # authenticated Hono routes (metadata only, never secrets)
    tools.ts           # agent-facing tool definitions
  email/
    README.md
    openmuse.plugin.json
    plugin.ts
    schemas.ts
    service.ts
    routes.ts
    tools.ts
```

Conventions:

- `service.ts` exports one class (e.g. `CredentialsService`). It is the only
  place that decrypts secrets, and it never returns a decrypted secret to a
  caller — only success/failure receipts and safe metadata.
- `schemas.ts` validates every request body and query with zod before the
  service ever sees it.
- `routes.ts` exports a function that builds a Hono sub-app, e.g.
  `credentialsRoutes(service)`. Routes return metadata only: ids, labels,
  username hints, domains. Decrypted values never appear in responses, logs,
  or error messages.
- `tools.ts` exports tool factory functions used by the chat agent
  (`engine/conversation.ts`) and the delegated-task worker
  (`engine/model.ts`). Tool results never contain secrets.
- Secrets are encrypted with the versioned AES-256-GCM envelope in
  `packages/integrations/src/vault.ts`, keyed by `TOKEN_ENCRYPTION_KEY`.
  Each connector stores its own record kind (see its README); records are
  scoped per owner.

## Registration

Connectors are plugins. Each connector folder carries an
`openmuse.plugin.json` manifest (the full convention is documented in
`docs/plugin-manifest.md`) plus a thin `plugin.ts` that adapts the
connector's existing service/routes/tools to the plugin host API:

1. `apps/server/src/app.ts` (`createApp`) discovers manifests under
   `apps/server/src/connectors` (plus `config.pluginRoots`), validates them,
   and loads each plugin: `plugin.ts` → `activate(ctx)` registers tools and
   returns the service instance and Hono routes.
2. Routes are mounted from the manifest's `contracts.routes.mountPath`
   (`/api/credentials`, `/api/email-accounts`); the plugin system API lives
   at `/api/plugins`.
3. Services are retrieved from the registry
   (`plugins.service("credentials")`) and passed where needed (agent
   service, workspace service).

Agent tools come from the registry: `engine/conversation.ts` (chat) resolves
plugin chat tools per owner and applies the existing tool-policy chain;
`engine/model.ts` (delegated tasks) resolves plugin worker tools through the
same host `defineTool` wrapper, so the policy chain still gates them.

Invalid manifests never crash startup — they are reported at
`GET /api/plugins/errors` and the plugin is skipped (visible as
`status: "error"` in `GET /api/plugins`).

## Security rules (non-negotiable)

1. Decrypted secrets exist only inside `service.ts`, in memory, for the
   shortest time needed, and are wiped (`= ""`) in a `finally` block.
2. API responses, tool results, logs, screenshots, and persisted evidence
   never contain secrets. List endpoints return metadata only.
3. External sends (email, browser fills) keep their existing approval or
   explicit-request gates; connectors never add an unrestricted path.
4. Email and web content is untrusted source data, never instructions.

## Current connectors

- `credentials/` — encrypted website logins, filled worker-side into the
  agent browser. Each credential is locked to its domain; a fill on any other
  domain is refused.
- `email/` — IMAP/SMTP email accounts. IMAP for folders, search and read;
  SMTP for sending, only through the reviewed action flow (`email.send`).
