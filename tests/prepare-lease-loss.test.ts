import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import { LostLeaseError, type TaskContext } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ProposalInput } from "../packages/domain/src/index.ts";

const owner = "owner-1";
const input: ProposalInput = {
  kind: "email.send",
  data: {
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "World",
    attachmentIds: [],
  },
};

const baseTask = (): AgentTask => ({
  id: "task-1",
  title: "t",
  prompt: "p",
  kind: "agent",
  status: "running",
  plan: [],
  evidence: [],
  input: {},
  state: { connectionId: "conn-1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  attempts: 1,
  leaseId: "lease-1",
  leaseUntil: null,
  artifactIds: [],
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openmuse-prepare-"));
  const db = await createStore({ dataDir: join(root, "pg") });
  const actions = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const service = new AgentService(
    db,
    {} as never,
    { connection: async () => ({ id: "conn-1" }) } as never,
    {} as never,
    actions,
    {} as never,
    {} as never,
  );
  await db.put(owner, "tasks", baseTask());
  return { root, db, actions, service };
}

const context = (overrides: Partial<TaskContext> = {}): TaskContext => ({
  signal: new AbortController().signal,
  guard: async () => {},
  checkpoint: async (patch: Partial<AgentTask>) => ({ ...baseTask(), ...patch }) as AgentTask,
  event: async () => {},
  ...overrides,
});

test("lease loss with an aborted worker signal leaves the proposal awaiting review", async () => {
  const { root, db, service } = await setup();
  try {
    const controller = new AbortController();
    controller.abort();
    const ctx = context({
      signal: controller.signal,
      checkpoint: async () => {
        throw new LostLeaseError();
      },
    });
    await assert.rejects(service.prepare(owner, baseTask(), input, "k1", ctx), LostLeaseError);
    const proposals = await db.list<{ id: string; status: string }>(owner, "actions");
    assert.equal(proposals.length, 1);
    assert.equal(
      proposals[0]?.status,
      "awaiting_review",
      "takeover retry must find the proposal still reviewable",
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the taking-over worker reuses the surviving proposal instead of failing", async () => {
  const { root, db, service } = await setup();
  try {
    const first = context({
      checkpoint: async () => {
        throw new Error("lease lost");
      },
    });
    await assert.rejects(service.prepare(owner, baseTask(), input, "k2", first));
    // Second worker, same task and key: must get the same live proposal back.
    const proposal = await service.prepare(owner, baseTask(), input, "k2", context());
    assert.equal(proposal.status, "awaiting_review");
    assert.equal((await db.list(owner, "actions")).length, 1, "no duplicate proposal minted");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const status of ["paused", "cancelled"] as const) {
  test(`a durably ${status} task auto-denies its orphaned proposal`, async () => {
    const { root, db, service } = await setup();
    try {
      await db.put(owner, "tasks", { ...baseTask(), status });
      const controller = new AbortController();
      controller.abort();
      const ctx = context({
        signal: controller.signal,
        checkpoint: async () => {
          throw new LostLeaseError();
        },
      });
      await assert.rejects(
        service.prepare(owner, baseTask(), input, `k3-${status}`, ctx),
        LostLeaseError,
      );
      const proposals = await db.list<{ status: string }>(owner, "actions");
      assert.equal(
        proposals[0]?.status,
        "denied",
        "a real pause/cancel must still clean up the orphaned review",
      );
    } finally {
      await db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
