import assert from "node:assert/strict";
import test from "node:test";
import { HeartbeatService } from "../apps/server/src/heartbeat/service.ts";
import { createAutomationTools } from "../apps/server/src/heartbeat/tools.ts";
import type { WorkspaceService } from "../apps/server/src/workspace.ts";

test("heartbeat and conditional automation rules", async (t) => {
  const nowMs = Date.now();

  const mockSnapshot = {
    mode: "sample",
    profile: { name: "Test User", email: "user@example.com" },
    mail: [
      {
        id: "m1",
        sender: "boss@corp.com",
        subject: "Urgent: Project Budget Review",
        unread: true,
        date: new Date(nowMs).toISOString(),
      },
      {
        id: "m2",
        sender: "newsletter@weekly.com",
        subject: "Your Weekly Digest",
        unread: false,
        date: new Date(nowMs).toISOString(),
      },
    ],
    events: [
      {
        id: "e1",
        title: "Strategy Sync",
        start: new Date(nowMs + 20 * 60 * 1000).toISOString(),
        end: new Date(nowMs + 50 * 60 * 1000).toISOString(),
      },
      {
        id: "e2",
        title: "Tomorrow Standup",
        start: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
        end: new Date(nowMs + 25 * 60 * 60 * 1000).toISOString(),
      },
    ],
    actions: [],
    files: [],
    browsers: [],
    activity: [],
    connections: [],
    runtime: { provider: "sample", configured: true, openbotConfigured: false },
  };

  const mockWorkspace = {
    snapshot: async () => mockSnapshot,
  } as unknown as WorkspaceService;

  const heartbeat = new HeartbeatService(mockWorkspace, undefined, {
    enabled: true,
    calendarAlertWindowMinutes: 30,
    alertUpcomingCalendar: true,
    alertUnreadEmails: true,
    notifyTelegram: false,
  });

  await t.test("evaluates default calendar and email alerts", async () => {
    const res = await heartbeat.pulse();
    assert.equal(res.alerts.length >= 2, true);
    const calAlert = res.alerts.find((a) => a.kind === "calendar");
    assert.ok(calAlert);
    assert.match(calAlert.title, /Strategy Sync/);

    const emailAlert = res.alerts.find((a) => a.kind === "email");
    assert.ok(emailAlert);
    assert.match(emailAlert.title, /Urgent: Project Budget/);
  });

  await t.test("deduplicates alerts on subsequent pulse", async () => {
    const res = await heartbeat.pulse();
    const dupeCal = res.alerts.find((a) => a.id.startsWith("cal:e1"));
    assert.equal(dupeCal, undefined);
  });

  await t.test("Home Assistant style IF/THEN automation rules", async () => {
    heartbeat.automations.addRule({
      name: "VIP Boss Alert",
      enabled: true,
      condition: {
        field: "unread_email_subject",
        operator: "contains",
        value: "budget",
      },
      action: {
        type: "telegram_alert",
        template: "Found critical email: {subject} from {sender}!",
      },
    });

    const res = await heartbeat.pulse();
    assert.equal(res.rulesEvaluated, 1);
    assert.equal(res.rulesTriggered, 1);
    const ruleAlert = res.alerts.find((a) => a.kind === "automation");
    assert.ok(ruleAlert);
    assert.match(
      ruleAlert.body,
      /Found critical email: Urgent: Project Budget Review from boss@corp.com/,
    );
  });

  await t.test("automation tools lifecycle", async () => {
    const tools = createAutomationTools(heartbeat);
    const createTool = tools.find((t) => t.name === "automation_create_rule");
    const listTool = tools.find((t) => t.name === "automation_list_rules");
    const deleteTool = tools.find((t) => t.name === "automation_delete_rule");

    assert.ok(createTool);
    assert.ok(listTool);
    assert.ok(deleteTool);

    const created = await (createTool as any).execute(
      {},
      {
        name: "Upcoming Meeting Reminder",
        field: "upcoming_meeting_minutes",
        operator: "less_than",
        value: 25,
        messageTemplate: "Prepare notes for {title} in {minutes}m!",
      },
    );
    assert.equal(created.ok, true);

    const listed = await (listTool as any).execute({}, {});
    assert.equal(listed.ok, true);
    assert.equal(listed.count >= 2, true);

    const deleted = await (deleteTool as any).execute({}, { ruleId: (created as any).rule.id });
    assert.equal(deleted.ok, true);
  });
});
