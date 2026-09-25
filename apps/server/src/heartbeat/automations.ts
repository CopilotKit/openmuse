import type { Workspace } from "../../../../packages/domain/src/index.ts";
import type { AutomationRule, HeartbeatAlert } from "./types.ts";

export class AutomationEngine {
  private rules: Map<string, AutomationRule> = new Map();
  private triggeredItemKeys = new Set<string>();

  constructor(initialRules: AutomationRule[] = []) {
    for (const r of initialRules) {
      this.rules.set(r.id, r);
    }
  }

  public getRules(): AutomationRule[] {
    return Array.from(this.rules.values());
  }

  public addRule(rule: Omit<AutomationRule, "id"> & { id?: string }): AutomationRule {
    const id = rule.id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullRule: AutomationRule = { ...rule, id };
    this.rules.set(id, fullRule);
    return fullRule;
  }

  public deleteRule(id: string): boolean {
    return this.rules.delete(id);
  }

  public evaluate(
    snap: Workspace,
    nowMs: number = Date.now(),
  ): { alerts: HeartbeatAlert[]; evaluated: number; triggered: number } {
    const alerts: HeartbeatAlert[] = [];
    let evaluated = 0;
    let triggered = 0;

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      evaluated++;

      const cond = rule.condition;
      let matched = false;
      let title = rule.name;
      let message = rule.action.template;

      // 1. Upcoming meeting check
      if (cond.field === "upcoming_meeting_minutes" && snap.events) {
        const threshold = Number(cond.value) || 30;
        for (const ev of snap.events) {
          const startMs = new Date(ev.start).getTime();
          const diffMinutes = Math.round((startMs - nowMs) / (60 * 1000));
          const passes =
            cond.operator === "less_than"
              ? diffMinutes >= 0 && diffMinutes <= threshold
              : cond.operator === "equals"
                ? Math.abs(diffMinutes - threshold) <= 2
                : diffMinutes >= threshold;

          if (passes) {
            const key = `${rule.id}:${ev.id}:${ev.start}`;
            if (!this.triggeredItemKeys.has(key)) {
              this.triggeredItemKeys.add(key);
              matched = true;
              message = message
                .replace(/{title}/g, ev.title)
                .replace(/{minutes}/g, String(diffMinutes));
              title = `⚡ Automation: ${rule.name}`;
              break;
            }
          }
        }
      }

      // 2. Unread email subject / sender
      if (
        (cond.field === "unread_email_subject" || cond.field === "unread_email_sender") &&
        snap.mail
      ) {
        const val = String(cond.value).toLowerCase();
        for (const m of snap.mail) {
          if (!m.unread) continue;
          const targetStr =
            cond.field === "unread_email_subject"
              ? m.subject.toLowerCase()
              : m.sender.toLowerCase();
          const passes =
            cond.operator === "contains"
              ? targetStr.includes(val)
              : cond.operator === "equals"
                ? targetStr === val
                : cond.operator === "matches"
                  ? new RegExp(val, "i").test(targetStr)
                  : false;

          if (passes) {
            const key = `${rule.id}:${m.id}`;
            if (!this.triggeredItemKeys.has(key)) {
              this.triggeredItemKeys.add(key);
              matched = true;
              message = message.replace(/{subject}/g, m.subject).replace(/{sender}/g, m.sender);
              title = `⚡ Automation: ${rule.name}`;
              break;
            }
          }
        }
      }

      if (matched) {
        triggered++;
        rule.lastTriggeredAt = new Date(nowMs).toISOString();
        alerts.push({
          id: `auto_${rule.id}_${nowMs}`,
          kind: "automation",
          title,
          body: message,
          timestamp: new Date(nowMs).toISOString(),
        });
      }
    }

    return { alerts, evaluated, triggered };
  }
}
