# Jev generative UI: aquarium school-trip demo

This recording follows a **scripted sample**, visibly labeled `Sample · scripted decisions` in its choice cards. AI Mock drives the conversation steps; OpenMuse runs its normal mailbox, browser, and `present_choices` tools. The mailbox is the fictional local Lincoln Middle School sample. Candidate copy is a controlled fixture, while the demo browser opens the aquarium's public pages before the comparison appears. The sample does **not** call live Jev.

## Run

From the repository root, install dependencies and configure a server-only CopilotKit Intelligence project key in the private `.env` as described in [Quick start](../../README.md#quick-start). Both sample and live modes require that key for Rich Threads. The sample needs no TypeSafe key or general model provider key.

```sh
pnpm --dir apps/worker exec playwright install chromium
pnpm dev:demo
```

The isolated launcher sets `JEV_MODE=sample`, starts AI Mock and the normal API on `127.0.0.1:8788`, and starts a real browser worker on `127.0.0.1:8791`. It forwards only the Intelligence key from the private configuration, not Google or model-provider credentials. Demo data stays under ignored `artifacts/demo/`.

In another terminal, start the app:

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm dev:web
```

Set the app's demo session token from `apps/server/src/demo/entry.ts` if the app requests one. Use the chat in a fresh task, then follow this sequence:

1. Send **Help me get ready for the aquarium trip**. The agent searches the fictional local mailbox, reads the matching thread, and shows **Complete permission slip**, **Review trip details**, and **Explore exhibits**.
2. Choose **Explore exhibits**. The real browser tool reads the aquarium's Kelp Forest, Open Sea, and Rocky Shore pages. Three sourced comparison cards appear.
3. Send **Something hands-on**. The sample scorer puts Rocky Shore first because its official page describes a bat-ray touch pool.
4. Choose **Rocky Shore**. The agent acknowledges the preference and offers to continue planning; no booking, send, or other external action occurs.
5. Reload the page and confirm the historical cards and final choice remain visible. Earlier choice controls should be disabled.

If the aquarium site or browser worker fails, the scripted agent reports the failed read and does not create a comparison card. The fixture is repeatable in its choices and copy, but public site availability and content can still change.

For a recording, show the `Sample · scripted decisions` caption, email card, clarification controls, inline browser progress, all three source links, changed hands-on ordering, and selection acknowledgement. Aim for 60–90 seconds. Verify the visible source pages still support each claim before publishing a new capture. The existing [demo recording guide](../DEMO.md#record-your-own-demo) covers web and simulator capture.

## Fixture provenance and live mode

The school, sender, recipient, message, and permission-slip document are fictional local workspace data in `apps/server/src/workspace.ts`. The candidate text in `apps/server/src/demo/jev-fixture.ts` was checked against Monterey Bay Aquarium's own pages on 2026-09-23:

| Candidate | Supported detail | Official source |
| --- | --- | --- |
| Kelp Forest | 28-foot kelp exhibit with sardines and leopard sharks | [Kelp Forest](https://www.montereybayaquarium.org/visit/exhibits/kelp-forest/) |
| Open Sea | Sea turtles, sardines, and tuna at a 90-foot viewing window | [Open Sea](https://www.montereybayaquarium.org/visit/exhibits/open-sea/) |
| Rocky Shore | Bat-ray touch pool | [Rocky Shore](https://www.montereybayaquarium.org/visit/exhibits/rocky-shore) |

For live Jev decisions, run the ordinary API with `JEV_MODE=live`, a server-side `TYPESAFE_API_KEY`, and the required `CPK_INTELLIGENCE_API_KEY`. Configure a real model and browser worker separately. The isolated `pnpm dev:demo` command always uses the labeled sample mode and does not forward a TypeSafe key. A sample recording must not be presented as evidence that live Jev was called.
