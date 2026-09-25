import type { TelegramService } from "../connectors/telegram/service.ts";
import type { WorkspaceService } from "../workspace.ts";
import { AutomationEngine } from "./automations.ts";
import {
  type AutomationRule,
  DEFAULT_HEARTBEAT_CONFIG,
  type HeartbeatAlert,
  type HeartbeatConfig,
  type HeartbeatPulseResult,
} from "./types.ts";

export class HeartbeatService {
  private config: HeartbeatConfig;
  private timer: NodeJS.Timeout | null = null;
  private alertedIds = new Set<string>();
  public readonly automations: AutomationEngine;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly telegram?: TelegramService,
    config?: Partial<HeartbeatConfig>,
    initialRules: AutomationRule[] = [],
  ) {
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
    this.automations = new AutomationEngine(initialRules);
  }

  public getConfig(): HeartbeatConfig {
    return { ...this.config };
  }

  public updateConfig(patch: Partial<HeartbeatConfig>): HeartbeatConfig {
    this.config = { ...this.config, ...patch };
    if (this.timer) {
      this.stop();
      this.start();
    }
    return this.config;
  }

  public start(): void {
    if (this.timer || !this.config.enabled) return;
    const intervalMs = Math.max(1, this.config.intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      void this.pulse().catch((err) => {
        console.error("[heartbeat] pulse failed:", err);
      });
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async pulse(owner: string = "default"): Promise<HeartbeatPulseResult> {
    const alerts: HeartbeatAlert[] = [];
    const now = new Date();
    const nowMs = now.getTime();
    let rulesEvaluated = 0;
    let rulesTriggered = 0;

    try {
      const snap = await this.workspace.snapshot(owner);

      // 1. Evaluate Home Assistant style conditional automation rules
      const autoResult = this.automations.evaluate(snap, nowMs);
      rulesEvaluated = autoResult.evaluated;
      rulesTriggered = autoResult.triggered;
      alerts.push(...autoResult.alerts);

      // 2. Calendar upcoming events check
      if (this.config.alertUpcomingCalendar && snap.events) {
        for (const ev of snap.events) {
          const startTime = new Date(ev.start).getTime();
          const diffMinutes = Math.round((startTime - nowMs) / (60 * 1000));
          if (diffMinutes >= 0 && diffMinutes <= this.config.calendarAlertWindowMinutes) {
            const alertKey = `cal:${ev.id}:${ev.start}`;
            if (!this.alertedIds.has(alertKey)) {
              this.alertedIds.add(alertKey);
              alerts.push({
                id: alertKey,
                kind: "calendar",
                title: `Upcoming: ${ev.title}`,
                body:
                  diffMinutes <= 1
                    ? `Starting right now: "${ev.title}"`
                    : `Starts in ${diffMinutes} minutes: "${ev.title}"`,
                timestamp: now.toISOString(),
              });
            }
          }
        }
      }

      // 3. Unread emails check
      if (this.config.alertUnreadEmails && snap.mail) {
        for (const m of snap.mail) {
          if (m.unread) {
            const alertKey = `mail:${m.id}`;
            if (!this.alertedIds.has(alertKey)) {
              this.alertedIds.add(alertKey);
              alerts.push({
                id: alertKey,
                kind: "email",
                title: `New Email: ${m.subject}`,
                body: `From ${m.sender}: "${m.subject}"`,
                timestamp: now.toISOString(),
              });
            }
          }
        }
      }

      // 4. Pending action proposals check
      if (this.config.alertPendingActions && snap.actions) {
        for (const act of snap.actions) {
          const alertKey = `act:${act.id}`;
          if (!this.alertedIds.has(alertKey)) {
            this.alertedIds.add(alertKey);
            alerts.push({
              id: alertKey,
              kind: "action",
              title: "Action Requires Review",
              body: act.title || `Pending action (${act.kind}) awaiting your approval.`,
              timestamp: now.toISOString(),
            });
          }
        }
      }
    } catch (e) {
      console.warn("[heartbeat] snapshot scan error:", e);
    }

    let dispatchedToTelegram = false;
    if (alerts.length > 0 && this.config.notifyTelegram && this.telegram) {
      const lines = alerts.map((a) => {
        const icon =
          a.kind === "calendar"
            ? "📅"
            : a.kind === "email"
              ? "✉️"
              : a.kind === "automation"
                ? "⚡"
                : "🔔";
        return `${icon} *${a.title}*\n${a.body}`;
      });
      const text = `🔔 *OpenMuse Alert*\n\n${lines.join("\n\n")}`;
      try {
        const res = await this.telegram.sendMessage(owner, text);
        dispatchedToTelegram = !!res.ok;
      } catch (err) {
        console.warn("[heartbeat] telegram dispatch failed:", err);
      }
    }

    return {
      timestamp: now.toISOString(),
      alerts,
      dispatchedToTelegram,
      rulesEvaluated,
      rulesTriggered,
    };
  }
}
