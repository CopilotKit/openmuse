import { randomUUID } from "node:crypto";
import {
  type ChatCompletionRequest,
  type ChatMessage,
  type FixtureResponse,
  getTextContent,
  LLMock,
} from "@copilotkit/aimock";
import { z } from "zod";
import { aquariumFixture, schoolTripFixture } from "./jev-fixture.ts";

export const demoModel = "openai/openmuse-browser-demo";

const pageSchema = z.object({
  sessionId: z.string().min(1),
  url: z.url(),
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

function targetUrl(prompt: string): string | undefined {
  if (/monterey|aquarium/i.test(prompt))
    return "https://www.montereybayaquarium.org/visit/exhibits";
  if (/copilotkit\.ai/i.test(prompt)) return "https://copilotkit.ai";
  if (/hacker\s*news|news\.ycombinator\.com|cool stuff/i.test(prompt))
    return "https://news.ycombinator.com";
  return undefined;
}

function summarizePage(message: ChatMessage): FixtureResponse {
  let value: unknown;
  try {
    value = JSON.parse(getTextContent(message.content) ?? "");
  } catch {
    return { content: "The browser did not return readable page data. Check the browser result." };
  }
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success)
    return { content: "The browser could not read that page. Check the browser result and retry." };
  const page = parsed.data;
  const lines = page.text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let excerpts: string[];
  let introduction: string;
  if (new URL(page.url).hostname === "news.ycombinator.com") {
    excerpts = lines
      .map(
        (line, index) =>
          /^\d+\.\s+(.+)$/.exec(line)?.[1] ?? (/^\d+\.$/.test(line) ? lines[index + 1] : undefined),
      )
      .filter((line): line is string => Boolean(line))
      .slice(0, 3);
    introduction = "From the current Hacker News front page:";
  } else if (new URL(page.url).hostname.endsWith("montereybayaquarium.org")) {
    excerpts = lines
      .flatMap((line, index) => {
        if (lines[index - 1] !== "EXHIBIT" || !/^(Kelp Forest|Open Sea|Sea Otters)$/i.test(line))
          return [];
        const description = lines[index + 1];
        return [
          description && description !== "Explore exhibit" ? `${line}: ${description}` : line,
        ];
      })
      .slice(0, 3);
    introduction = "Exhibits from the aquarium’s own guide:";
  } else {
    excerpts = lines
      .filter((line) => line.length >= 45 && /agent|copilotkit|ag.ui|framework/i.test(line))
      .slice(0, 3);
    introduction = "From CopilotKit’s current page:";
  }
  if (!excerpts.length) {
    excerpts = lines.filter((line) => line.length >= 30).slice(0, 3);
    introduction = "Here are excerpts from the page I just opened:";
  }
  if (!excerpts.length)
    return { content: "The page opened, but it did not expose enough readable text to summarize." };
  const bullets = excerpts.map(
    (line) => `• ${line.length > 110 ? `${line.slice(0, 110).replace(/\s+\S*$/, "")}…` : line}`,
  );
  return {
    content: `${introduction}\n\n${bullets.join("\n")}\n\nSource: ${page.url}${page.truncated ? "\nThe browser returned a shortened page extract." : ""}`,
  };
}

function turnResult(turn: ChatMessage[], name: string, prefix: string) {
  const ids = new Set(
    turn.flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function.name === name)
        .map((call) => call.id),
    ),
  );
  return turn.findLast(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id &&
      (ids.has(message.tool_call_id) || message.tool_call_id.startsWith(prefix)),
  );
}

function parseResult(message: ChatMessage): unknown {
  try {
    return JSON.parse(getTextContent(message.content) ?? "");
  } catch {
    return undefined;
  }
}

function demoMailResponse(request: ChatCompletionRequest, turn: ChatMessage[]): FixtureResponse {
  const read = turnResult(turn, "read_mail_thread", "call_openmuse_demo_mail_read_");
  if (read) {
    const parsed = z
      .object({
        messages: z.array(z.object({ sender: z.string(), subject: z.string(), body: z.string() })),
      })
      .safeParse(parseResult(read));
    const message = parsed.success ? parsed.data.messages.at(-1) : undefined;
    if (!message)
      return {
        content: "I couldn’t read the school-trip email. Check the mail result and try again.",
      };
    const paragraphs = message.body
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter((text) => text.length > 40 && !/local workspace/i.test(text))
      .slice(0, 2);
    if (!paragraphs.length)
      return { content: "The email was found, but it did not include readable trip details." };
    return {
      content: `From ${message.sender}:\n“${message.subject}”\n\n${paragraphs.join("\n\n")}\n\nI can look up the aquarium next.`,
    };
  }
  const search = turnResult(turn, "search_mail", "call_openmuse_demo_mail_search_");
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ threadId: z.string(), subject: z.string() })) })
      .safeParse(parseResult(search));
    if (!parsed.success)
      return { content: "I couldn’t check your inbox. Check the mail connection and try again." };
    const match = parsed.data.matches[0];
    if (!match) return { content: "I didn’t find a school-trip email in the connected mailbox." };
    if (!request.tools?.some((tool) => tool.function.name === "read_mail_thread"))
      return {
        content: "The email reader is unavailable. Open Mail to read the matching message.",
      };
    return {
      content: "I found the school’s reminder. I’ll read the details.",
      toolCalls: [
        {
          id: `call_openmuse_demo_mail_read_${randomUUID()}`,
          name: "read_mail_thread",
          arguments: JSON.stringify({ threadId: match.threadId }),
        },
      ],
    };
  }
  if (!request.tools?.some((tool) => tool.function.name === "search_mail"))
    return { content: "Mail search is unavailable. Connect the mailbox before checking email." };
  return {
    content: "I’ll check your inbox for the school trip.",
    toolCalls: [
      {
        id: `call_openmuse_demo_mail_search_${randomUUID()}`,
        name: "search_mail",
        arguments: JSON.stringify({ query: "aquarium" }),
      },
    ],
  };
}

function demoTripResponse(request: ChatCompletionRequest, turn: ChatMessage[]): FixtureResponse {
  const choice = turnResult(turn, "present_choices", "call_openmuse_demo_jev_");
  if (choice) {
    const parsed = z
      .object({ panel: z.object({ id: z.string() }).nullable(), error: z.string().optional() })
      .safeParse(parseResult(choice));
    return parsed.success && parsed.data.panel
      ? { content: "I found the school reminder. Choose what you’d like to work on first." }
      : {
          content:
            "I couldn’t prepare the trip choices. Please try again when choices are available.",
        };
  }
  const read = turnResult(turn, "read_mail_thread", "call_openmuse_demo_mail_read_");
  if (read) {
    const parsed = z
      .object({
        messages: z.array(z.object({ sender: z.string(), subject: z.string(), body: z.string() })),
      })
      .safeParse(parseResult(read));
    const message = parsed.success ? parsed.data.messages.at(-1) : undefined;
    if (!message)
      return { content: "I couldn’t read the school-trip email. Check Mail and try again." };
    if (!request.tools?.some((tool) => tool.function.name === "present_choices"))
      return {
        content:
          "The choices tool is unavailable. Please try again after enabling Jev sample mode.",
      };
    return {
      content:
        "The school reminder mentions the permission slip and trip details. I’ll lay out the next steps.",
      toolCalls: [
        {
          id: `call_openmuse_demo_jev_${randomUUID()}`,
          name: "present_choices",
          arguments: JSON.stringify({
            message: "Help me get ready for the aquarium trip",
            context: `${schoolTripFixture.school}: ${message.subject}. ${message.body.slice(0, 1200)}`,
            title: "How should we get ready?",
            control: "clarification",
            options: schoolTripFixture.choices,
          }),
        },
      ],
    };
  }
  const search = turnResult(turn, "search_mail", "call_openmuse_demo_mail_search_");
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ threadId: z.string(), subject: z.string() })) })
      .safeParse(parseResult(search));
    if (!parsed.success) return { content: "I couldn’t check the mailbox for the school trip." };
    const match = parsed.data.matches[0];
    if (!match) return { content: "I didn’t find a school-trip email in the sample mailbox." };
    if (!request.tools?.some((tool) => tool.function.name === "read_mail_thread"))
      return { content: "The email reader is unavailable." };
    return {
      content: "I found the school reminder. I’ll read it before suggesting next steps.",
      toolCalls: [
        {
          id: `call_openmuse_demo_mail_read_${randomUUID()}`,
          name: "read_mail_thread",
          arguments: JSON.stringify({ threadId: match.threadId }),
        },
      ],
    };
  }
  if (!request.tools?.some((tool) => tool.function.name === "search_mail"))
    return { content: "Mail search is unavailable. Connect the sample mailbox and try again." };
  return {
    content: "I’ll check the sample school email first.",
    toolCalls: [
      {
        id: `call_openmuse_demo_mail_search_${randomUUID()}`,
        name: "search_mail",
        arguments: JSON.stringify({ query: schoolTripFixture.searchQuery }),
      },
    ],
  };
}

function previousComparisonId(messages: ChatMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool") continue;
    const parsed = z
      .object({ panel: z.object({ id: z.string(), type: z.literal("comparison") }) })
      .safeParse(parseResult(message));
    if (parsed.success) return parsed.data.panel.id;
  }
  return undefined;
}

function demoExhibitResponse(request: ChatCompletionRequest, turn: ChatMessage[]): FixtureResponse {
  const choice = turnResult(turn, "present_choices", "call_openmuse_demo_jev_");
  if (choice) {
    const parsed = z
      .object({ panel: z.object({ id: z.string() }).nullable(), error: z.string().optional() })
      .safeParse(parseResult(choice));
    return parsed.success && parsed.data.panel
      ? {
          content:
            "Here are three researched exhibits from the sample script. Tell me what matters most, or choose one.",
        }
      : { content: "I couldn’t prepare the exhibit choices. Please retry." };
  }
  const browseResults = turn.filter(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id?.startsWith("call_openmuse_demo_exhibit_browse_"),
  );
  const observed = new Set<string>();
  for (const result of browseResults) {
    const parsed = pageSchema.safeParse(parseResult(result));
    if (!parsed.success || !parsed.data.text.trim())
      return {
        content:
          "I couldn’t read an aquarium exhibit page, so I can’t prepare sourced choices yet.",
      };
    observed.add(parsed.data.url.replace(/\/$/, ""));
  }
  const next = aquariumFixture.options.find(
    (option) => !observed.has(option.sources[0].url.replace(/\/$/, "")),
  );
  if (next) {
    if (!request.tools?.some((tool) => tool.function.name === "browse_web"))
      return { content: "The browser is unavailable, so I can’t research the exhibits." };
    return {
      content: `I’ll read the aquarium’s ${next.label} page.`,
      toolCalls: [
        {
          id: `call_openmuse_demo_exhibit_browse_${randomUUID()}`,
          name: "browse_web",
          arguments: JSON.stringify({ url: next.sources[0].url }),
        },
      ],
    };
  }
  if (!request.tools?.some((tool) => tool.function.name === "present_choices"))
    return {
      content: "The choices tool is unavailable. Please try again after enabling Jev sample mode.",
    };
  return {
    content: "The three aquarium pages are open. I’ll compare their verified exhibit details.",
    toolCalls: [
      {
        id: `call_openmuse_demo_jev_${randomUUID()}`,
        name: "present_choices",
        arguments: JSON.stringify({
          message: "Explore exhibits for the aquarium school trip",
          context:
            "Controlled sample candidate descriptions, checked against official Monterey Bay Aquarium exhibit pages. Browser reads for all three sources succeeded in this turn.",
          title: "Three exhibits to explore",
          control: "comparison",
          options: aquariumFixture.options,
        }),
      },
    ],
  };
}

function demoRefinementResponse(
  request: ChatCompletionRequest,
  turn: ChatMessage[],
): FixtureResponse {
  const choice = turnResult(turn, "present_choices", "call_openmuse_demo_jev_");
  if (choice) {
    const parsed = z
      .object({ panel: z.object({ id: z.string() }).nullable(), error: z.string().optional() })
      .safeParse(parseResult(choice));
    return parsed.success && parsed.data.panel
      ? {
          content:
            "Rocky Shore has the aquarium’s bat-ray touch pool. The cards now put that hands-on option first in this scripted sample.",
        }
      : { content: "I couldn’t refine the exhibit choices. Please retry." };
  }
  const currentUserIndex = request.messages.findLastIndex((message) => message.role === "user");
  const panelId = previousComparisonId(request.messages.slice(0, currentUserIndex));
  if (!panelId)
    return {
      content: "I don’t have an exhibit comparison to refine yet. Choose Explore exhibits first.",
    };
  if (!request.tools?.some((tool) => tool.function.name === "present_choices"))
    return {
      content: "The choices tool is unavailable. Please try again after enabling Jev sample mode.",
    };
  return {
    content: "I’ll bring the hands-on option to the front.",
    toolCalls: [
      {
        id: `call_openmuse_demo_jev_${randomUUID()}`,
        name: "present_choices",
        arguments: JSON.stringify({
          message: "Something hands-on",
          context:
            "Refine the researched comparison: Rocky Shore offers a bat-ray touch pool; the other two are viewing exhibits.",
          title: "Hands-on exhibit first",
          control: "comparison",
          refinementPanelId: panelId,
          options: aquariumFixture.options,
        }),
      },
    ],
  };
}

/** Script only the model: the app executes real mailbox reads and browser tools. */
export function demoResponse(request: ChatCompletionRequest): FixtureResponse {
  const userIndex = request.messages.findLastIndex((message) => message.role === "user");
  const user = request.messages[userIndex];
  const prompt = user ? (getTextContent(user.content) ?? "") : "";
  const turn = request.messages.slice(userIndex + 1);
  if (/help me get ready for the aquarium trip/i.test(prompt))
    return demoTripResponse(request, turn);
  if (/explore exhibits/i.test(prompt)) return demoExhibitResponse(request, turn);
  if (/something hands.on/i.test(prompt)) return demoRefinementResponse(request, turn);
  if (
    /I choose [“"]?(?:Rocky Shore|Kelp Forest|Open Sea)/i.test(prompt) ||
    /^(?:Rocky Shore|Kelp Forest|Open Sea)$/i.test(prompt)
  ) {
    const label = /Rocky Shore|Kelp Forest|Open Sea/i.exec(prompt)?.[0] ?? "that exhibit";
    return {
      content: `You chose ${label}. I can help plan a route through the aquarium or review the school-trip details next.`,
    };
  }
  if (/email|inbox/i.test(prompt)) return demoMailResponse(request, turn);
  const url = targetUrl(prompt);
  if (!url)
    return {
      content:
        "Try “Find cool stuff on Hacker News”, “Summarize copilotkit.ai”, “Check my emails for the school trip”, or “Research Monterey Bay Aquarium”.",
    };

  // Only the latest turn can satisfy this request; older browser reads cannot suppress a new visit.
  const calls = new Set(
    turn.flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function.name === "browse_web")
        .map((call) => call.id),
    ),
  );
  const result = turn.findLast(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id &&
      (calls.has(message.tool_call_id) ||
        message.tool_call_id.startsWith("call_openmuse_demo_browse_")),
  );
  if (result) return summarizePage(result);
  if (!request.tools?.some((tool) => tool.function.name === "browse_web"))
    return { content: "The browse_web tool is not available. Start the API with browser support." };
  return {
    content: url.includes("ycombinator")
      ? "I’ll open Hacker News and read the front page."
      : url.includes("montereybayaquarium")
        ? "I’ll research the exhibits on the aquarium’s own website."
        : "I’ll open CopilotKit and read the page.",
    toolCalls: [
      {
        id: `call_openmuse_demo_browse_${randomUUID()}`,
        name: "browse_web",
        arguments: JSON.stringify({ url }),
      },
    ],
  };
}

export function createDemoModel(
  options: { port?: number; latency?: number; firstByteDelay?: number } = {},
) {
  const latency = options.latency ?? 80;
  const firstByteDelay = options.firstByteDelay ?? options.latency ?? 1500;
  if (![latency, firstByteDelay].every((value) => Number.isFinite(value) && value >= 0))
    throw new Error("Demo model delays must be finite nonnegative milliseconds");
  return new LLMock({
    host: "127.0.0.1",
    port: options.port ?? 0,
    latency,
    chunkSize: 14,
    strict: true,
    logLevel: "silent",
    journalMaxEntries: 100,
  }).on({ model: "openmuse-browser-demo" }, demoResponse, {
    streamingProfile: { ttft: firstByteDelay },
  });
}
