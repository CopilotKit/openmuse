/**
 * Plain-text email cleanup shared by the web and native EmailBody renderers.
 *
 * Text-only messages (ticketing systems, plain-text senders, mailing lists)
 * arrive as raw text full of `>` quote markers, `*` emphasis markers and
 * stray blank lines. These helpers turn that into a professional,
 * Outlook-style rendering: real quote blocks instead of `>` soup, collapsed
 * whitespace, bold/italic from `*` markers, linkified URLs and `<hr>` rules
 * for signature/delimiter lines.
 */

const MAX_QUOTE_DEPTH = 6;

interface ParsedLine {
  depth: number;
  text: string;
}

/** Split off leading `>` quote markers (">", "> >", "> > >") from a line. */
function parseLine(raw: string): ParsedLine {
  const match = raw.match(/^((?:\s*>\s*)+)/);
  if (!match) return { depth: 0, text: raw };
  const depth = Math.min(MAX_QUOTE_DEPTH, (match[1].match(/>/g) ?? []).length);
  return { depth, text: raw.slice(match[1].length) };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Linkify http(s) URLs and email addresses in already-escaped HTML. */
function linkify(escaped: string): string {
  return escaped
    .replace(/(https?:\/\/[^\s<>"')\]]+)/g, (url) => {
      // Keep trailing punctuation outside the link.
      const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? "";
      const clean = trailing ? url.slice(0, -trailing.length) : url;
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${trailing}`;
    })
    .replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, '<a href="mailto:$1">$1</a>');
}

/** `**bold**` marker -> <strong> (trims the captured text). */
function bold(escaped: string): string {
  return escaped.replace(
    /\*\*([^*]+?)\*\*/g,
    (_m, inner: string) => `<strong>${inner.trim()}</strong>`,
  );
}

/** `*italic*` marker -> <em> (trims the captured text). */
function italic(escaped: string): string {
  return escaped.replace(
    /(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g,
    (_m, pre: string, inner: string) => `${pre}<em>${inner.trim()}</em>`,
  );
}

/** Inline `**bold**` / `*italic*` markers -> HTML, then linkify. */
function inlineHtml(text: string): string {
  return linkify(italic(bold(escapeHtml(text))));
}

/** `**** Some ticket delimiter ****` -> muted centered note. */
function ticketNote(text: string): string | null {
  const match = text.match(/^\*{2,}\s+(.+?)\s+\*{2,}$/);
  return match ? match[1].trim() : null;
}

const SEPARATOR_RE = /^([-*_=])\1{2,}\s*$/;
const SIG_RE = /^--\s?$/;

const TEXT_CSS = [
  "body{margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,",
  '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.65;',
  "color:#1c1c1c;background:#fff;word-wrap:break-word}",
  "p{margin:0 0 10px}p:last-child{margin-bottom:0}",
  "blockquote{margin:8px 0;padding:4px 0 4px 12px;border-left:3px solid #c7d2fe;color:#4b5563}",
  "blockquote blockquote{border-left-color:#a5b4fc;margin:6px 0}",
  "blockquote p{margin:0 0 8px}",
  "hr{border:none;border-top:1px solid #e5e7eb;margin:14px 0}",
  ".sig{color:#6b7280;font-size:13px}",
  ".ticket-note{color:#9ca3af;font-size:12px;text-align:center;margin:12px 0}",
  "a{color:#1a73e8;text-decoration:none}a:hover{text-decoration:underline}",
].join("");

/**
 * Convert a plain-text email body into a complete, styled HTML document:
 * quote blocks, collapsed whitespace, bold/italic, linkified URLs.
 */
export function plainTextToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(parseLine);
  let html = "";
  let openDepth = 0;
  let para: string[] = [];
  let inSig = false;

  const closePara = () => {
    if (para.length > 0) {
      const cls = inSig ? ' class="sig"' : "";
      html += `<p${cls}>${para.map(inlineHtml).join("<br>")}</p>`;
      para = [];
    }
  };
  const setDepth = (depth: number) => {
    while (openDepth < depth) {
      closePara();
      html += "<blockquote>";
      openDepth += 1;
    }
    while (openDepth > depth) {
      closePara();
      html += "</blockquote>";
      openDepth -= 1;
    }
  };

  for (const { depth, text: rawText } of lines) {
    const line = rawText.replace(/[ \t]+$/, "");
    // Delimiter rows stay at the current quote depth so a quote is not
    // split into fragments around its separators.
    const note = ticketNote(line);
    if (note !== null) {
      closePara();
      setDepth(depth);
      html += `<div class="ticket-note">${inlineHtml(note)}</div>`;
      continue;
    }
    if (SEPARATOR_RE.test(line) || SIG_RE.test(line)) {
      if (SIG_RE.test(line)) inSig = true;
      closePara();
      setDepth(depth);
      html += "<hr>";
      continue;
    }
    if (line === "") {
      closePara();
      continue;
    }
    setDepth(depth);
    para.push(line);
  }
  closePara();
  setDepth(0);

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<base target="_blank"><style>${TEXT_CSS}</style></head>` +
    `<body><div class="email-text">${html || "<p></p>"}</div></body></html>`
  );
}

const RULE = "─".repeat(28);

/**
 * Native-friendly cleanup: strip `>` markers (indent quotes), collapse
 * blank lines, drop emphasis markers, turn delimiter rows into rules.
 */
export function cleanPlainText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const indent = (depth: number) => "  ".repeat(depth);
  for (const raw of lines) {
    const { depth, text: rawText } = parseLine(raw);
    const line = rawText.replace(/[ \t]+$/, "");
    const note = ticketNote(line);
    if (note !== null) {
      out.push(
        "",
        `${indent(depth)}${RULE}`,
        `${indent(depth)}${note}`,
        `${indent(depth)}${RULE}`,
        "",
      );
      continue;
    }
    if (SEPARATOR_RE.test(line) || SIG_RE.test(line)) {
      out.push(`${indent(depth)}${RULE}`);
      continue;
    }
    const cleaned = line
      .replace(/\*\*([^*]+?)\*\*/g, (_m, inner: string) => inner.trim())
      .replace(
        /(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g,
        (_m, pre: string, inner: string) => `${pre}${inner.trim()}`,
      )
      .replace(/[ \t]+$/, "");
    if (cleaned === "") {
      out.push("");
      continue;
    }
    out.push(`${indent(depth)}${cleaned}`);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

const RICH_TAG_RE = /<(blockquote|table|img|ul|ol|h[1-6]|hr|pre|figure)\b/i;

/** Best-effort HTML -> text for messages whose HTML is just wrapped text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");
}

/**
 * True when an HTML body carries no real structure and just wraps plain
 * text (e.g. naive text->HTML conversions that keep `>` quote markers).
 * Those render far better through the plain-text pipeline.
 */
export function isFlatTextHtml(html: string): boolean {
  if (RICH_TAG_RE.test(html)) return false;
  return htmlToText(html)
    .split("\n")
    .some((line) => line.trimStart().startsWith(">"));
}
