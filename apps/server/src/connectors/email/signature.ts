/**
 * Work-email identity rule: mail sent from work@example.com is
 * always signed "Work User", never "Owner".
 *
 * Applied inside the send path (EmailService.send and the Gmail send branch),
 * so every transport — the agent's email.send tool, the reviewed action flow,
 * and calendar invites — carries the right signature without the caller
 * having to remember it.
 */
export const WORK_EMAIL_ADDRESS = "work@example.com";
const WORK_SIGNATURE = "Work User";

/**
 * Enforce the work-email signature on an outgoing body. Non-work senders are
 * returned untouched. For the work address: a trailing "Owner" sign-off is
 * replaced, an existing "Work User" sign-off is kept, otherwise the signature
 * is appended. Only the signature position (last non-empty line) is ever
 * touched — mentions of Owner elsewhere in the body are left alone.
 */
export function applyWorkSignature(body: string, fromAddress: string): string {
  if (fromAddress.trim().toLowerCase() !== WORK_EMAIL_ADDRESS) return body;
  const lines = body.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last >= 0) {
    const signature = lines[last].trim();
    if (/^work user$/i.test(signature)) return body;
    if (/^owner(\s+user)?$/i.test(signature)) {
      lines[last] = WORK_SIGNATURE;
      return lines.join("\n");
    }
  }
  return `${body.replace(/\s+$/, "")}\n\n${WORK_SIGNATURE}`;
}
