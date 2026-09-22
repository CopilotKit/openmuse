# Automatic Learning operator guide

Automatic Learning lets a live OpenMuse deployment turn repeated, completed interactive conversations into reviewed CopilotKit Skills. OpenMuse sends eligible Rich Threads to one focused Learning container, a human reviews the evidence and proposed Skill, and later invocations of the built-in chat agent can load the published Skill.

Use this guide when you are operating a live OpenMuse API with CopilotKit Intelligence. The local sample remains key-free and does not collect Learning evidence.

Official CopilotKit references:

- [Automatic Learning](https://docs.copilotkit.ai/learning)
- [Automatic learned skill delivery](https://docs.copilotkit.ai/intelligence/learned-skills)

## What OpenMuse collects

OpenMuse assigns new live Rich Threads for the interactive `default` runtime agent to the configured Learning container before the first agent run. That covers the main conversation and side chats handled by OpenMuse's built-in model assistant.

This increment does not collect the background task worker's internal runs. It also does not configure skill delivery for an external raw AG-UI backend. If you set `AGENT_BACKEND=agui`, that external agent server owns its own Learning delivery setup.

Published Skills do not change the model itself. They are reviewed instructions made available to later agent invocations, and the model decides when to load and follow a relevant Skill.

## Prerequisites

Before you enable Learning, you need:

- A live OpenMuse deployment using `WORKSPACE_MODE=live`.
- A model-backed built-in agent, for example `AGENT_BACKEND=model` with `MODEL` and the matching provider key.
- A CopilotKit Intelligence project used by the same OpenMuse deployment.
- Rich Threads working in live mode, with completed conversations visible in the Intelligence project.
- Operator access to the Intelligence project's Learning area.
- Only public or synthetic evidence if you are recording a demo or pull request acceptance artifact.

Keep all provider keys and the CopilotKit Intelligence key server-only. Do not expose them through `EXPO_PUBLIC_`, `NEXT_PUBLIC_`, `VITE_`, a mobile bundle, screenshots, or a recording.

## Create a focused Learning container

In the CopilotKit Intelligence project used by OpenMuse:

1. Open **Learning**.
2. Create a Learning container for one repeated OpenMuse workflow.
3. Give it a stable ID, a descriptive name, and optional guidance for what good work looks like.
4. Keep the container focused. For example, use one container for public-page research response structure, not every possible personal-assistant task.

The stable ID must contain 1-64 lowercase letters, numbers, or single hyphens. It cannot start or end with a hyphen, and it cannot contain repeated hyphens.

Good examples:

```text
openmuse-assistant
public-research
email-triage
```

Invalid examples:

```text
OpenMuse
openmuse_assistant
-openmuse
openmuse--
```

Existing Threads are not backfilled. A Thread cannot move between Learning containers, so choose the stable ID before you ask users to produce acceptance evidence.

## Configure OpenMuse

Set both Intelligence values on the API server:

```dotenv
CPK_INTELLIGENCE_API_KEY=your-project-key
CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=openmuse-assistant
```

`CPK_INTELLIGENCE_API_KEY` is secret. `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` is not a secret, but it still belongs in server configuration so the runtime assigns Threads consistently.

Restart the API after changing either value.

Live mode fails loudly when configuration is missing or invalid:

- Missing `CPK_INTELLIGENCE_API_KEY` prevents the API from starting because Rich Threads are required in live mode.
- Missing `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` prevents the API from starting because Automatic Learning cannot collect evidence without a container.
- An invalid container ID prevents startup and reports the exact stable-ID format.

Sample mode can leave both values unset. It keeps local conversation history and does not send Learning evidence.

## Collect evidence

Use OpenMuse normally and complete several related live conversations in the built-in chat. Corrections, tool calls, application interactions, and final answers all help Learning understand the pattern.

For acceptance recording, use public pages and synthetic prompts only. A focused public-page research workflow is safer than a private mailbox or calendar workflow because it avoids personal data and third-party account evidence.

CopilotKit Learning shows the eligible Thread count in the container. By default, Automatic Learning needs 15 eligible Threads for the first successful run and 15 new eligible Threads after a successful run. If the container shows a different threshold, use the value shown in the Intelligence UI. You can start a manual run with the available evidence when you need to analyze a focused set of Threads before the daily schedule or automatic threshold.

## Run analysis, review, and publish

In the Learning container:

1. Wait for the scheduled run, or select **Start manual run now**.
2. Watch the analysis result.
3. Open each Insight and inspect its supporting Threads.
4. Confirm the evidence is public or synthetic if you are preparing a recording.
5. Approve only Skill candidates you want future OpenMuse invocations to use.
6. Publish the approved Skill revision.

Automatic Learning never approves or publishes Skills for you. A scheduled run can produce Insights and Skill candidates, but publication remains a human review step.

## Enable delivery

After publishing a Skill, open the container's **Skills** tab and confirm Skill delivery is enabled.

OpenMuse already passes the configured container to the built-in model assistant when `WORKSPACE_MODE=live` and `AGENT_BACKEND=model`. Leave `CPK_INTELLIGENCE_SKILLS_REVISION` unset unless you intentionally want to pin an exact published revision. With the default configuration, fresh invocations follow the latest published Skills after the delivery refresh window.

Delivery applies only to new invocations. A conversation already in progress keeps the Skill snapshot it captured for that invocation.

## Verify a fresh invocation

Start a new OpenMuse conversation after the Skill is published and delivery is enabled. Ask for a task that should match the approved Skill.

Verify all of these checkpoints:

1. The new Thread is in live Rich Threads, not the local sample store.
2. The agent invocation receives the published Skill catalog.
3. The run shows `copilotkit_load_skill` when the model chooses to load the Skill.
4. If the Skill has supporting files, `copilotkit_read_skill_file` can read them.
5. The final answer follows the approved structured result from the published Skill.

Loading the Skill is the delivery proof. Copying the setup prompt or toggling delivery is not enough by itself.

## Secret-safe recording runbook

Use this checklist before recording a managed acceptance run:

1. Use a disposable live OpenMuse deployment or a private operator environment.
2. Use a focused Learning container in the same Intelligence project as the API.
3. Keep `.env`, terminal output, dashboard project keys, provider keys, access keys, and private account content out of frame.
4. Use public web pages and synthetic prompts only.
5. Prepare enough completed Threads for the container to show eligible evidence.
6. Record the new Thread appearing as evidence, the manual analysis, supporting Threads, review, approval, publication, delivery enabled, and a fresh invocation loading the Skill.
7. Review the recording before sharing it. Trim or blur accidental keys, private project details, and private evidence.
8. Attach large MP4 artifacts to the pull request or release notes instead of committing them to Git.

The sample app remains key-free. Do not add real Intelligence or provider keys to committed demo files.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The live API exits with a missing Intelligence key error. | Set `CPK_INTELLIGENCE_API_KEY` on the API server with the generated project key. Keep it server-only. |
| The live API exits with a missing Learning container error. | Create a focused container in the Intelligence project's Learning area and set `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` to its stable ID. |
| The live API exits with an invalid container ID error. | Use 1-64 lowercase letters, numbers, or single hyphens, with no leading, trailing, or repeated hyphen. |
| A Thread does not appear in the container. | Confirm it was a new live Rich Thread handled by the built-in interactive `default` model assistant. Existing Threads are not backfilled, and external AG-UI agents own their own delivery. |
| Learning says there are not enough eligible Threads. | Complete more related Threads for an automatic run, or start a manual run with the available evidence when you need to review a focused set before the threshold. The default threshold is 15 eligible Threads unless the UI shows a different value. |
| The analysis or delivery snapshot is unavailable or failed. | Inspect the failed analysis or delivery status in the Learning container, fix the cause, then start a fresh invocation or run manual analysis again after adding eligible evidence. OpenMuse does not hide this failure. |
| A published Skill is not used in OpenMuse. | Confirm delivery is enabled, the Skill is published, OpenMuse is in live model mode, the API has the same project key and container ID, and you started a fresh invocation. |
| Delivery is disabled or the snapshot is denied. | Re-enable delivery in the container's Skills tab or remove an invalid exact revision pin. A confirmed delivery denial blocks new invocations rather than silently ignoring the failure. |

## Next links

- [CopilotKit Rich Threads](RICH-THREADS.md) explains the live conversation persistence that provides Learning evidence.
- [Verification and limitations](VERIFICATION.md) records what has and has not been accepted for this release.
- [Security policy](../SECURITY.md) describes evidence handling and public-demo safety.
