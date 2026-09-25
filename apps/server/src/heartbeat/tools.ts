import { z } from "zod";
import type { HeartbeatService } from "./service.ts";

export function createAutomationTools(heartbeat: HeartbeatService) {
  return [
    {
      name: "automation_create_rule",
      description:
        "Create a Home Assistant style automation rule: IF condition met, THEN trigger an alert/action on the next heartbeat cycle.",
      parameters: z.object({
        name: z.string().describe("Human readable rule name, e.g. Alert urgent client emails"),
        field: z
          .enum(["upcoming_meeting_minutes", "unread_email_subject", "unread_email_sender"])
          .describe("Condition target to watch"),
        operator: z
          .enum(["less_than", "greater_than", "equals", "contains"])
          .describe("Comparison operator"),
        value: z.union([z.string(), z.number()]).describe("Threshold or substring to match"),
        messageTemplate: z
          .string()
          .describe("Alert template (can use {title}, {minutes}, {subject}, {sender})"),
      }),
      requiresApproval: false,
      execute: async (
        _ctx: any,
        args: {
          name: string;
          field: "upcoming_meeting_minutes" | "unread_email_subject" | "unread_email_sender";
          operator: "less_than" | "greater_than" | "equals" | "contains";
          value: string | number;
          messageTemplate: string;
        },
      ) => {
        const rule = heartbeat.automations.addRule({
          name: args.name,
          enabled: true,
          condition: {
            field: args.field,
            operator: args.operator,
            value: args.value,
          },
          action: {
            type: "telegram_alert",
            template: args.messageTemplate,
          },
        });
        return {
          ok: true,
          message: `Automation rule "${rule.name}" created with ID ${rule.id}. It will be checked every heartbeat pulse.`,
          rule,
        };
      },
    },
    {
      name: "automation_list_rules",
      description:
        "List all active Home Assistant style conditional automation rules currently monitored by OpenMuse.",
      parameters: z.object({}),
      requiresApproval: false,
      execute: async () => {
        const rules = heartbeat.automations.getRules();
        return {
          ok: true,
          count: rules.length,
          rules,
        };
      },
    },
    {
      name: "automation_delete_rule",
      description: "Delete an existing conditional automation rule by ID.",
      parameters: z.object({
        ruleId: z.string().describe("The ID of the rule to remove"),
      }),
      requiresApproval: false,
      execute: async (_ctx: any, args: { ruleId: string }) => {
        const deleted = heartbeat.automations.deleteRule(args.ruleId);
        return {
          ok: deleted,
          message: deleted ? `Rule ${args.ruleId} removed.` : `Rule ${args.ruleId} not found.`,
        };
      },
    },
  ];
}
