import { useMemo } from "react";
import { htmlToText, isFlatTextHtml, plainTextToHtml } from "./emailText";
import { colors } from "./ui";

/**
 * Render a real email body on web inside a sandboxed iframe with no script
 * permission, so the message looks like a proper email -- images, tables,
 * colors and formatting intact -- without letting it run code.
 *
 * Messages with real HTML use it directly (sanitized). Text-only messages,
 * and HTML bodies that are just wrapped plain text, go through the
 * plain-text pipeline: `>` quotes become Outlook-style quote blocks,
 * whitespace collapses, `*` markers become bold/italic, URLs linkify.
 */
function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"')
    .replace(/<\s*meta[^>]*http-equiv[^>]*>/gi, "");
}

function wrapHtmlDoc(inner: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<base target="_blank">` +
    `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:14px;line-height:1.65;color:#1c1c1c;margin:0;padding:18px;word-wrap:break-word}` +
    `img{max-width:100%;height:auto}a{color:#1a73e8}table{max-width:100%}blockquote{` +
    `border-left:3px solid #d7dde3;margin:12px 0;padding:6px 12px;color:#555}</style></head>` +
    `<body>${inner}</body></html>`
  );
}

export default function EmailBody({ html, text }: { html?: string; text: string }) {
  const doc = useMemo(() => {
    const richHtml = html?.trim() ? html : "";
    if (richHtml && !isFlatTextHtml(richHtml)) {
      return wrapHtmlDoc(sanitizeEmailHtml(richHtml));
    }
    // Text-only, or HTML that is just wrapped text: use the cleaned pipeline.
    return plainTextToHtml(richHtml ? htmlToText(richHtml) : text);
  }, [html, text]);

  if (!text?.trim() && !html?.trim()) {
    return null;
  }
  return (
    <iframe
      title="Email message"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      style={{
        width: "100%",
        height: 620,
        border: `1px solid ${colors.line}`,
        borderRadius: 10,
        background: "#ffffff",
      }}
    />
  );
}
