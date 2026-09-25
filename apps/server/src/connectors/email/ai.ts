/**
 * Lightweight model helpers for the mail compose box: AI reply drafts and
 * grammar fixes.
 *
 * Uses the server's configured OpenAI-compatible chat endpoint (DeepSeek by
 * default via OPENAI_BASE_URL / OPENAI_API_KEY / MODEL) — the same model the
 * agent runs on. These helpers only return text for the user to review in the
 * compose sheet; nothing here sends mail.
 */

const MAX_INPUT_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 45000;

/** The model is unreachable, unconfigured, or returned nothing usable. */
export class AiUnavailableError extends Error {}

function baseUrl(): string {
  return (process.env.OPENAI_BASE_URL?.trim() || "https://api.deepseek.com/v1").replace(/\/+$/, "");
}

function modelName(): string {
  const spec = process.env.MODEL?.trim() || "deepseek-chat";
  // Specs look like "openai/deepseek-chat" — the API wants the part after "/".
  const slash = spec.indexOf("/");
  return slash >= 0 ? spec.slice(slash + 1) : spec;
}

/** One OpenAI-compatible chat completion; throws AiUnavailableError on failure. */
export async function chatComplete(system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) throw new AiUnavailableError("No model API key is configured on the server.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName(),
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user.slice(0, MAX_INPUT_CHARS) },
        ],
      }),
    });
    if (!res.ok) throw new AiUnavailableError(`Model request failed (HTTP ${res.status}).`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new AiUnavailableError("The model returned an empty response.");
    return text;
  } catch (e) {
    if (e instanceof AiUnavailableError) throw e;
    throw new AiUnavailableError(
      `Model request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface OriginalMessage {
  from: string;
  sender?: string;
  subject: string;
  body: string;
}

/** Draft a short professional reply to the quoted original message. */
export async function draftReply(original: OriginalMessage): Promise<string> {
  const who = original.sender ? `${original.sender} <${original.from}>` : original.from;
  return chatComplete(
    "You draft short, professional email replies. Write only the reply body — no subject line, no 'From/To' header, no signature block, no quotation of the original message. Plain text, a few sentences.",
    `Draft a polite, professional reply to this email:\n\nFrom: ${who}\nSubject: ${original.subject}\n\n${original.body.slice(0, MAX_INPUT_CHARS)}`,
  );
}

/** Fix grammar, spelling, and punctuation, preserving meaning and tone. */
export async function fixGrammarText(text: string): Promise<string> {
  return chatComplete(
    "You fix grammar, spelling, and punctuation in email drafts. Preserve the writer's meaning, tone, and paragraph breaks exactly. Return ONLY the corrected text — no explanations, no surrounding quotation marks.",
    text,
  );
}
