import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentNotification, AgentTask, Idea, Monitor } from "../packages/domain/src/agent.ts";
import type { ActionProposal, Artifact } from "../packages/domain/src/index.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
const owner = "workflow-user";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-workflows-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  await server.workspace.ensureSample(owner, server.actions);
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function documentTask() {
  const w = await server.workspace.snapshot(owner);
  const mail = w.mail.find((m) => m.attachments.length);
  assert.ok(mail);
  const task = await server.agent.createTask(owner, {
    title: "Return school form",
    prompt: "Fill the school form and prepare a reply",
    kind: "document",
    input: { messageId: mail.id },
  });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask(owner, task.id);
  assert.equal(waiting.status, "waiting_input");
  assert.ok(Array.isArray(waiting.state.missingFields));
  await server.agent.answer(owner, task.id, "Use these fictional test values", {
    participant_name: "Test Student",
    guardian_name: "Test Guardian",
    permission_granted: true,
  });
  await server.agent.worker.tick();
  const reviewed = await server.agent.detail(owner, task.id);
  assert.equal(reviewed.task.status, "waiting_approval");
  assert.equal(reviewed.files.length, 1);
  assert.ok(reviewed.files[0].url);
  assert.ok(reviewed.task.actionId);
  const action = await db.get<ActionProposal>(owner, "actions", reviewed.task.actionId);
  assert.ok(action);
  assert.equal(action.taskId, task.id);
  return { task: reviewed.task, action, originalId: mail.attachments[0] };
}

test("document job runs without a client, waits for review, and resumes from its receipt", async () => {
  const initialIdeas = await server.agent.refreshIdeas(owner);
  const originalIdea = initialIdeas.find((idea) => idea.kind === "document");
  assert.ok(originalIdea);
  const { task, action, originalId } = await documentTask();
  assert.equal((await server.files.get(owner, originalId)).parentId, undefined);
  assert.equal(
    (await server.workspace.snapshot(owner)).mail.filter((m) => m.subject.startsWith("Re:")).length,
    0,
  );
  await server.agent.control(owner, task.id, "pause");
  await assert.rejects(
    server.actions.decide(owner, action.id, action.hash, "approve"),
    /Resume the task/,
  );
  await server.agent.control(owner, task.id, "resume");
  const receipt = await server.actions.decide(owner, action.id, action.hash, "approve");
  assert.equal(receipt.status, "succeeded");
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
  const notices = await db.list<AgentNotification>(owner, "notifications");
  assert.equal(notices.filter((n) => n.taskId === task.id && n.title === task.title).length, 1);
  await server.agent.worker.tick();
  assert.equal(
    (await db.list<ActionProposal>(owner, "actions")).filter((a) => a.taskId === task.id).length,
    1,
  );
  const refreshedIdeas = await server.agent.refreshIdeas(owner);
  assert.equal(refreshedIdeas.find((idea) => idea.id === originalIdea.id)?.status, "dismissed");
  assert.equal(
    refreshedIdeas.filter((idea) => idea.kind === "document" && idea.status === "new").length,
    0,
  );
});

test("document retry reuses the filled PDF after its task checkpoint is lost", async (t) => {
  const replayOwner = "interrupted-document";
  await server.workspace.ensureSample(replayOwner, server.actions);
  const workspace = await server.workspace.snapshot(replayOwner);
  const mail = workspace.mail.find((message) => message.attachments.length);
  assert.ok(mail);
  const task = await server.agent.createTask(replayOwner, {
    prompt: "Fill the sample form",
    kind: "document",
    input: { messageId: mail.id, fields: { participant_name: "Sample Student" } },
  });
  const compareAndSwap = db.compareAndSwap.bind(db);
  let interrupted = false;
  t.mock.method(db, "compareAndSwap", async (...args: Parameters<Store["compareAndSwap"]>) => {
    const [recordOwner, kind, id, , patch] = args;
    if (
      recordOwner === replayOwner &&
      kind === "tasks" &&
      id === task.id &&
      (patch.state as AgentTask["state"] | undefined)?.filledId &&
      !interrupted
    ) {
      interrupted = true;
      return null;
    }
    return compareAndSwap(...args);
  });
  await server.agent.worker.tick();
  assert.ok(interrupted);
  const retry = await server.agent.getTask(replayOwner, task.id);
  assert.equal(retry.status, "queued");
  assert.equal(retry.state.filledId, undefined);
  const outputs = (await db.list<Artifact>(replayOwner, "files")).filter((file) => file.parentId);
  assert.equal(outputs.length, 1);

  await server.agent.worker.tick();
  const resumed = await server.agent.getTask(replayOwner, task.id);
  assert.equal(resumed.status, "waiting_approval", resumed.error ?? resumed.question);
  assert.equal(resumed.state.filledId, outputs[0].id);
  assert.equal(
    (await db.list<Artifact>(replayOwner, "files")).filter((file) => file.parentId).length,
    1,
  );
});

test("attachment import recovers after losing its mapping and isolates reconnections", async (t) => {
  const attachmentOwner = "attachment-recovery";
  await server.workspace.ensureSample(attachmentOwner, server.actions);
  const workspace = await server.workspace.snapshot(attachmentOwner);
  const mail = workspace.mail[0];
  const reference = `${mail.id}:sample-attachment:sample.pdf`;
  await db.put(attachmentOwner, "mail", {
    ...mail,
    attachments: [reference],
    connectionId: "sample-google",
  });
  const google = server.workspace.google(attachmentOwner);
  const bytes = await createSamplePdf();
  t.mock.method(google, "getAttachment", async () => bytes);
  t.mock.method(server.workspace, "google", () => google);
  const put = db.put.bind(db);
  let interrupted = false;
  t.mock.method(db, "put", async (...args: Parameters<Store["put"]>) => {
    if (args[0] === attachmentOwner && args[1] === "imports" && !interrupted) {
      interrupted = true;
      throw new Error("mapping unavailable");
    }
    return put(...args);
  });
  const before = await server.files.list(attachmentOwner);
  await assert.rejects(
    server.workspace.importAttachment(attachmentOwner, reference),
    /mapping unavailable/,
  );
  const published = (await server.files.list(attachmentOwner)).find(
    (file) => !before.some((old) => old.id === file.id),
  );
  assert.ok(published);
  const recovered = await server.workspace.importAttachment(attachmentOwner, reference);
  assert.equal(recovered.id, published.id);
  assert.equal((await server.files.list(attachmentOwner)).length, before.length + 1);

  await db.put(attachmentOwner, "settings", { id: "google", connectionId: "new-connection" });
  await db.put(attachmentOwner, "mail", {
    ...mail,
    attachments: [reference],
    connectionId: "new-connection",
  });
  assert.notEqual(
    (await server.workspace.importAttachment(attachmentOwner, reference)).id,
    recovered.id,
  );
});

test("ideas ignore sent replies while retaining unfinished incoming requests", async () => {
  const ideaOwner = "sent-reply-ideas";
  await server.workspace.ensureSample(ideaOwner, server.actions);
  const workspace = await server.workspace.snapshot(ideaOwner);
  const incoming = workspace.mail.find((mail) => mail.attachments.length);
  assert.ok(incoming);
  await server.workspace.execute(ideaOwner, {
    kind: "email.send",
    data: {
      to: [incoming.from],
      cc: [],
      bcc: [],
      subject: "Re: Complete the form and schedule a meeting",
      body: "Here is the completed permission form. Let's meet for coffee.",
      attachmentIds: incoming.attachments,
    },
  });
  const ideas = await server.agent.refreshIdeas(ideaOwner);
  const sent = (await server.workspace.snapshot(ideaOwner)).mail.find(
    (mail) => mail.sender === "You",
  );
  assert.ok(sent);
  assert.ok(ideas.some((idea) => idea.input.messageId === incoming.id));
  assert.ok(!ideas.some((idea) => idea.input.messageId === sent.id));
});

test("cancelling a task denies its pending action", async () => {
  const { task, action } = await documentTask();
  await server.agent.control(owner, task.id, "cancel");
  assert.equal(
    (await server.actions.decide(owner, action.id, action.hash, "approve")).status,
    "denied",
  );
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(owner, task.id)).status, "cancelled");
});

test("failed page checks back off, expose the error, and pause after repeated failures", async () => {
  const monitor = await server.agent.createMonitor(owner, {
    title: "Public availability",
    url: "https://example.com",
  });
  for (let i = 1; i <= 5; i++) {
    await server.agent.worker.tick();
    const task = await server.agent.getTask(owner, monitor.taskId);
    assert.equal(task.status, i < 5 ? "scheduled" : "paused");
    assert.ok(task.error);
    assert.equal(task.state.failures, i);
    if (i < 5)
      await db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "scheduled" },
        { nextRunAt: "2020-01-01T00:00:00Z" },
      );
  }
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
});

test("dismissal racing acceptance never creates work for a dismissed idea", async () => {
  for (let i = 0; i < 4; i++) {
    const idea: Idea = {
      id: `race-${i}`,
      title: `Plan a walk ${i}`,
      reason: "User context",
      prompt: "Plan a walk",
      kind: "plan",
      input: {},
      evidence: [],
      status: "new",
      createdAt: new Date().toISOString(),
    };
    await db.put(owner, "ideas", idea);
    await Promise.all([
      server.agent.decideIdea(owner, idea.id, "dismiss"),
      server.agent.decideIdea(owner, idea.id, "accept"),
    ]);
    const saved = await db.get<Idea>(owner, "ideas", idea.id);
    const tasks = await db.list<AgentTask>(owner, "tasks");
    if (saved?.status === "dismissed")
      assert.equal(tasks.filter((t) => t.title === idea.title).length, 0);
    else assert.ok(saved?.taskId && tasks.some((t) => t.id === saved.taskId));
  }
});
