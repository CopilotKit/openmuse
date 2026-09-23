import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { presentChoicesParameters } from "../apps/server/src/jev/tools.ts";
import { encodeJevAction } from "../packages/domain/src/jev.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

const options = [{ id: "explore", label: "Explore exhibits", details: [], sources: [] }];
const comparisonOption = (url: string) => ({
  id: "a",
  label: "A",
  details: [],
  sources: [{ title: "Source", url }],
});

test("refinement may omit options but new panels still need candidates", () => {
  const base = {
    message: "Refine",
    context: "Earlier panel",
    title: "Choices",
    control: "comparison",
  };
  assert.doesNotThrow(() =>
    presentChoicesParameters.parse({ ...base, options: [], refinementPanelId: "previous" }),
  );
  assert.throws(() => presentChoicesParameters.parse({ ...base, options: [] }));
});
function input(content: string, threadId = "jev-thread"): RunAgentInput {
  return {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content }],
    tools: [],
    context: [],
    state: {},
  };
}
async function fixture(
  t: TestContext,
  calls: Array<{ name: string; arguments: object } | undefined>,
) {
  await modelFixture(t, (index) => calls[index]);
  const browser = await browserFixture(t, () => ({
    data: { url: "https://example.org", title: "Example", text: "Observed", truncated: false },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    jevMode: "sample" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  return {
    ...browser,
    ...app,
    conversation: new ConversationAgent(config, app.agent, "local-user"),
  };
}

test("present_choices emits a complete panel and selection uses trusted stored label", async (t) => {
  const f = await fixture(t, [
    { name: "search_mail", arguments: { query: "aquarium" } },
    { name: "read_mail_thread", arguments: { threadId: "trip-thread" } },
    {
      name: "present_choices",
      arguments: {
        message: "Help with trip",
        context: "School email",
        title: "What next?",
        control: "clarification",
        options,
      },
    },
    undefined,
  ]);
  await f.workspace.ensureSample("local-user", f.actions);
  const events = await lastValueFrom(
    f.conversation.run(input("Help with aquarium trip")).pipe(toArray()),
  );
  const result = events.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  const panel = JSON.parse(String(result.content)).panel;
  assert.equal(panel.options[0].label, "Explore exhibits");
  assert.equal(panel.mode, "sample");
  const action = encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "explore",
  });
  const selected = await lastValueFrom(f.conversation.run(input(action)).pipe(toArray()));
  assert.equal(selected.at(-1)?.type, EventType.RUN_FINISHED);
  const stored = await f.db.get<{ selectedId: string }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(stored?.selectedId, "explore");
});

test("invalid and cross-thread actions return a run error without model execution", async (t) => {
  const f = await fixture(t, []);
  const events = await lastValueFrom(
    f.conversation.run(input("[OpenMuse choice] bad-json")).pipe(toArray()),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  const cross = await lastValueFrom(
    f.conversation
      .run(
        input(
          encodeJevAction({
            panelId: "missing",
            threadId: "foreign",
            candidateSetVersion: 1,
            optionId: "a",
          }),
        ),
      )
      .pipe(toArray()),
  );
  assert.equal(cross.at(-1)?.type, EventType.RUN_ERROR);
});

test("live choices reject unobserved source pages without creating a panel", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "present_choices",
          arguments: {
            message: "Compare",
            context: "Claimed research",
            title: "Exhibits",
            control: "comparison",
            options: [
              {
                id: "a",
                label: "A",
                details: [],
                sources: [{ title: "Source", url: "https://example.org/a" }],
              },
            ],
          },
        }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({
    status: 502,
    data: { error: { message: "Read failed" } },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const events = await lastValueFrom(agent.run(input("Compare exhibits")).pipe(toArray()));
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.equal(JSON.parse(String(result.content)).panel, null);
  assert.match(JSON.parse(String(result.content)).error, /Read the source page/);
  assert.deepEqual(await browser.db.list("local-user", "jev_panels"), []);
});

test("a redirected browse does not prove the requested source URL", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "browse_web", arguments: { url: "https://example.org/original" } }
      : index === 1
        ? {
            name: "present_choices",
            arguments: {
              message: "Compare",
              context: "Observed page",
              title: "Exhibits",
              control: "comparison",
              options: [comparisonOption("https://example.org/original")],
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, (path, body) => ({
    data: path.endsWith("/read")
      ? {
          url: "https://example.org/redirected",
          title: "Redirected",
          text: "Other page",
          truncated: false,
        }
      : {
          id: body.id,
          url: body.url,
          title: "Opened",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const events = await lastValueFrom(agent.run(input("Compare exhibits")).pipe(toArray()));
  const result = events.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel === null,
  );
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.match(JSON.parse(String(result.content)).error, /Read the source page/);
});

test("mail read in an earlier run does not authorize a new live clarification", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "read_mail_thread", arguments: { threadId: "trip-thread" } }
      : index === 2
        ? {
            name: "present_choices",
            arguments: {
              message: "Trip",
              context: "Earlier mail",
              title: "Next",
              control: "clarification",
              options,
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, () => ({
    data: { url: "https://example.org", title: "Example", text: "Observed", truncated: false },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  await app.workspace.ensureSample("local-user", app.actions);
  const adapter = {
    decide: async () => ({ control: "clarification" as const, scores: { explore: 1 } }),
  };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  await lastValueFrom(agent.run(input("Read trip mail")).pipe(toArray()));
  const events = await lastValueFrom(agent.run(input("Now clarify")).pipe(toArray()));
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.equal(JSON.parse(String(result.content)).panel, null);
  assert.match(JSON.parse(String(result.content)).error, /Read the relevant email/);
});

test("live refinement reuses the verified stored sources with no new browse or options", async (t) => {
  let panelId = "";
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "browse_web", arguments: { url: "https://example.org/exhibit" } }
      : index === 1
        ? {
            name: "present_choices",
            arguments: {
              message: "Compare",
              context: "Observed exhibit",
              title: "Exhibits",
              control: "comparison",
              options: [comparisonOption("https://example.org/exhibit")],
            },
          }
        : index === 3
          ? {
              name: "present_choices",
              arguments: {
                message: "Something hands-on",
                context: "Earlier verified exhibit",
                title: "Hands-on exhibits",
                control: "comparison",
                options: [],
                refinementPanelId: panelId,
              },
            }
          : undefined,
  );
  const browser = await browserFixture(t, (path, body) => ({
    data: path.endsWith("/read")
      ? {
          url: "https://example.org/exhibit",
          title: "Exhibit",
          text: "Observed exhibit facts",
          truncated: false,
        }
      : {
          id: body.id,
          url: body.url,
          title: "Opened",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const first = await lastValueFrom(agent.run(input("Compare exhibits")).pipe(toArray()));
  const firstPanel = first.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(firstPanel && firstPanel.type === EventType.TOOL_CALL_RESULT);
  panelId = JSON.parse(String(firstPanel.content)).panel.id;
  const second = await lastValueFrom(agent.run(input("Something hands-on")).pipe(toArray()));
  const refined = second.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(refined && refined.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(
    JSON.parse(String(refined.content)).panel.options.map((option: { id: string }) => option.id),
    ["a"],
  );
});
