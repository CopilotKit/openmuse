/** The agent computer's status, shown in the header and read out by its button label. */
export function computerStatus(available: boolean, activeSessions: number) {
  return !available ? "offline" : activeSessions > 0 ? "take control" : "ready";
}
