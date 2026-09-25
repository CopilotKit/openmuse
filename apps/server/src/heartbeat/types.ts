export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  alertUpcomingCalendar: boolean;
  calendarAlertWindowMinutes: number;
  alertUnreadEmails: boolean;
  alertPendingActions: boolean;
  notifyTelegram: boolean;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalMinutes: 15,
  alertUpcomingCalendar: true,
  calendarAlertWindowMinutes: 35,
  alertUnreadEmails: true,
  alertPendingActions: true,
  notifyTelegram: true,
};

export interface HeartbeatAlert {
  id: string;
  kind: "calendar" | "email" | "action" | "automation" | "summary";
  title: string;
  body: string;
  timestamp: string;
}

export interface HeartbeatPulseResult {
  timestamp: string;
  alerts: HeartbeatAlert[];
  dispatchedToTelegram: boolean;
  rulesEvaluated: number;
  rulesTriggered: number;
}

export interface AutomationCondition {
  field:
    | "upcoming_meeting_minutes"
    | "unread_email_subject"
    | "unread_email_sender"
    | "service_health"
    | "custom";
  operator: "less_than" | "greater_than" | "equals" | "contains" | "matches";
  value: string | number;
}

export interface AutomationAction {
  type: "telegram_alert" | "in_app_notification" | "create_proposal";
  template: string;
}

export interface AutomationRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  condition: AutomationCondition;
  action: AutomationAction;
  lastTriggeredAt?: string;
}
