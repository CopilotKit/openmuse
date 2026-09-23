import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type {
  AgentNotification,
  AgentTask,
  Evidence,
  Idea,
  Monitor,
} from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";

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

test("monitor evidence identifies each check separately from the monitor", async () => {
  const monitor = await server.agent.createMonitor(owner, {
    title: "Sample availability provenance",
    url: "sample://availability",
    intervalMinutes: 1,
  });
  const observed: Evidence[] = [];
  for (let i = 0; i < 2; i++) {
    await server.agent.worker.tick();
    const task = await server.agent.getTask(owner, monitor.taskId);
    assert.equal(task.status, "scheduled");
    assert.equal(task.evidence.length, 1);
    observed.push(task.evidence[0]);
    await db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "scheduled" },
      { nextRunAt: "2020-01-01T00:00:00Z" },
    );
  }
  for (const item of observed) {
    assert.notEqual(item.id, monitor.id);
    assert.equal(item.provenance?.acquisition, "monitor");
    assert.equal(item.provenance?.sourceId, monitor.id);
    assert.ok(item.provenance && !Number.isNaN(Date.parse(item.provenance.observedAt)));
  }
  assert.notEqual(observed[0].id, observed[1].id);
});

test("browser reads, search excerpts and legacy evidence survive a store round trip", async () => {
  const page = {
    sessionId: "browser-session-1",
    url: "https://example.com/menu",
    title: "Menu",
    text: "Tonight's specials",
  };
  const first = server.agent.browserEvidence(page);
  const second = server.agent.browserEvidence({ ...page, text: "Updated specials" });
  assert.notEqual(first.id, second.id);
  assert.equal(first.provenance?.sourceId, page.sessionId);
  assert.equal(second.provenance?.sourceId, page.sessionId);
  const search: Evidence = {
    id: "search-result-1",
    kind: "web",
    title: page.title,
    url: page.url,
    excerpt: "Tonight's specials",
    provenance: {
      acquisition: "search",
      observedAt: new Date().toISOString(),
      provider: "example-search",
    },
  };
  const legacy: Evidence = { id: "legacy-mail", kind: "mail", title: "Old", excerpt: "Old body" };
  const task = await server.agent.createTask(owner, {
    title: "Provenance round trip",
    prompt: "Keep evidence",
    kind: "agent",
    input: {},
  });
  await db.put(owner, "tasks", { ...task, evidence: [first, second, search, legacy] });
  const saved = (await db.get<AgentTask>(owner, "tasks", task.id))?.evidence ?? [];
  const sameUrl = saved.filter((item) => item.url === page.url);
  assert.deepEqual(
    sameUrl.map((item) => item.provenance?.acquisition),
    ["browser", "browser", "search"],
  );
  assert.equal(saved.find((item) => item.id === "legacy-mail")?.provenance, undefined);
});

test("mail evidence identifies each observation separately from its message", async () => {
  const [mail] = (await server.workspace.snapshot(owner)).mail;
  assert.ok(mail);
  const first = server.agent.mailEvidence(mail);
  const second = server.agent.mailEvidence(mail);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, mail.id);
  assert.equal(first.kind, "mail");
  assert.deepEqual(
    { acquisition: first.provenance?.acquisition, sourceId: first.provenance?.sourceId },
    { acquisition: "mail", sourceId: mail.id },
  );
});
