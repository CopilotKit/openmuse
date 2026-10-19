export interface ComputerCommand {
  id: string;
  command: string;
  /** Full input binding for keyed desktop actions; command is only a short display label. */
  actionHash?: string;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "interrupted";
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt?: string;
}
export interface ComputerSnapshot {
  enabled: boolean;
  provider: "docker" | "e2b-desktop" | "boxcompute";
  /** The computer has a graphical desktop: use_desktop, the Desktop tab and the chat card. */
  desktop: boolean;
  status: "unconfigured" | "stopped" | "running" | "error";
  workspacePath: "/workspace";
  /** Docker runs with networking off; the desktop providers need internet for their GUI browser. */
  network: "disabled" | "enabled";
  message?: string;
  commands: ComputerCommand[];
}
export interface ComputerDirectory {
  path: string;
  entries: { name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[];
}
