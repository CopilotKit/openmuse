import { createContext, useContext } from "react";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  CalendarEvent,
  EmailDraft,
  EventDraft,
  Mail,
  Section,
  Workspace,
} from "../../../packages/domain/src";
import type { MuseApi, SessionUser } from "./api";
/** Quoted original attached to a reply draft so the compose box can ask
 * the server for an AI-drafted reply without another round-trip. */
export interface ReplyToSnapshot {
  from: string;
  sender?: string;
  subject: string;
  body: string;
}
export type Detail =
  | { type: "account" }
  | { type: "mail"; mail: Mail }
  | {
      type: "email";
      draft?: Partial<EmailDraft> & { id?: string; replyToSnapshot?: ReplyToSnapshot };
    }
  | { type: "event"; event?: CalendarEvent; draft?: EventDraft; neighbors?: CalendarEvent[] }
  | { type: "file"; file: Artifact }
  | { type: "browser"; browser: BrowserSession }
  | { type: "review"; action: ActionProposal }
  | { type: "task"; taskId: string }
  | { type: "delegate" }
  | { type: "notifications" }
  | { type: "computer" }
  | { type: "menu" }
  | { type: "users" };
export interface WorkspaceContextValue {
  workspace: Workspace;
  api: MuseApi;
  sessionUser: SessionUser;
  section: Section;
  navigate: (section: Section) => void;
  refresh: () => Promise<void>;
  open: (detail: Detail) => void;
  close: () => void;
  notify: (message: string) => void;
  ask: (prompt: string) => void;
  logout: () => Promise<void>;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable");
  return context;
}
