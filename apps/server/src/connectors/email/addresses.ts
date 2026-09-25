/** Shared mail-address helpers (used by the service and the mirror store). */

export interface MailAddress {
  name?: string;
  address?: string;
}

export const addressOf = (entry: MailAddress): string => entry.address ?? "";

export const displayName = (entry?: MailAddress): string => entry?.name || entry?.address || "";
