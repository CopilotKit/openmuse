# OpenMuse telemetry

OpenMuse measures template setup on Expo web, iOS and Android. A random installation UUID is saved in browser localStorage or the native app document directory; it is independent of the developer's `CPK_TELEMETRY_ID` and existing runtime/thread identity.

The client emits `oss.onboarding.step_viewed` for the visible welcome, connect, workspace and first-answer views; `setup_failed` adds a categorical error class; `setup_abandoned` recovers an unfinished setup at the next launch; `activated` occurs once after a successful fresh, noncancelled run produces a displayed assistant answer. Replayed history, tool-only responses and errored partial responses do not activate. Backgrounding alone does not mark abandonment.

Events contain an event UUID, Unix-second timestamp, platform, numeric app version and the accessibility title `OpenMuse`. They contain no prompts, answer text, exception details, credentials, URLs, paths, emails, model names, device hardware identifiers or thread IDs. The persisted schema rejects unknown properties. Storage or secure randomness failure suppresses capture for that session and never blocks workspace access.

The client POSTs directly to `https://telemetry.copilotkit.ai/ingest` with `Content-Type: application/json` and its installation UUID in `X-CopilotKit-Telemetry-Id`, without authorization. `EXPO_PUBLIC_COPILOTKIT_TELEMETRY_URL` overrides the receiver for deliberate local testing. Events are persisted before delivery; at most 256 are retained, evicting oldest events. Transient failures retry with exponential delays up to 60 seconds, at most ten attempts and seven days. Other 4xx responses are dropped. Requests time out after five seconds. Launch/resume retries and pagehide flushes are best effort.

A successful authenticated session includes `telemetryEnabled`; a disabled response suspends and purges client capture before further delivery. Authenticated `POST /api/telemetry/onboarding-link` accepts only installation/event UUIDs, platform and app version. The server supplies its validated `CPK_TELEMETRY_ID`, sends `oss.onboarding.identity_linked` under that project identity, and returns only `{ enabled, linked }`. Link retries retain their event UUID and bounds without storing tokens or server URLs. A missing project ID ends that session's link attempt; a new authenticated launch can try again. The server uses `COPILOTKIT_TELEMETRY_URL` for deliberate local testing.

The link is join evidence between installation and project events. It does not alias PostHog persons, change runtime account attribution, automatically resolve an onboarding email, or merge historical users. Shared sink namespace deployment is required for downstream delivery; an HTTP 202 alone cannot prove PostHog ingestion.

## Opt out

Set `EXPO_PUBLIC_COPILOTKIT_TELEMETRY_DISABLED=true` or `1` when building the client. Web also honors `navigator.doNotTrack` or `window.doNotTrack` equal to `1`. These opt-outs prevent identity creation, recording, storage and requests, and remove existing local telemetry state.

Set server `COPILOTKIT_TELEMETRY_DISABLED=true` or `1`, `DO_NOT_TRACK=true` or `1`, or `COPILOTKIT_TELEMETRY_SAMPLE_RATE=0` to disable both runtime telemetry and onboarding linkage. Pair a server opt-out with the client build opt-out for deployment-wide suppression: a server flag cannot prevent pre-auth direct traffic from a separately built client, or retract already delivered events.

Browser persistence is scoped to one active tab per installation. Concurrent tabs can race over the same localStorage record; use one tab during setup. Clearing site/app data resets installation identity and activation. Expo exports verify bundling on all three platforms; they do not substitute for installed-device lifecycle testing.
