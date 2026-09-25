export function browserAddress(value: string): string {
  const input = value.trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /\s/.test(input)
    )
      throw new Error("Invalid address");
    return url.href;
  } catch {
    throw new Error("Enter a website address, like copilotkit.ai or https://news.ycombinator.com.");
  }
}

export function browserSite(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}

/**
 * Short, honest subtitle for a browse_web failure. The card must never show
 * a generic "couldn't read the page" when the tool reported a specific
 * cause (session limit, blocked page, worker down, ...).
 */
export function browserErrorSummary(error: string): string {
  if (/close an active session|session limit/i.test(error)) return "Browser session limit reached";
  if (/could not be loaded|unreachable|timed out|navigation failed|connection refused/i.test(error))
    return "The page couldn't be loaded";
  if (/blocked|not permitted|forbidden/i.test(error)) return "That page is blocked";
  if (/worker is not configured|worker.*unavailable/i.test(error))
    return "Browser worker unavailable";
  const trimmed = error.trim();
  return trimmed.length > 110 ? `${trimmed.slice(0, 110)}…` : trimmed;
}
