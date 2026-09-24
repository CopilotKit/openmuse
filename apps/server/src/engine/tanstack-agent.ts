import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  BuiltInAgent,
  type BuiltInAgentLearnedSkills,
  type BuiltInAgentLearnedSkillsOptions,
  convertInputToTanStackAI,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import {
  chat,
  type JSONSchema,
  maxIterations,
  type SchemaInput,
  toolDefinition,
} from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { type OpenAIChatModel, openaiText } from "@tanstack/ai-openai";
import { map, Observable } from "rxjs";
import { z } from "zod";

// Same "provider/model" strings, env vars and base URL formats as the AI SDK resolver in
// @copilotkit/runtime. Retries are off, like the old `maxRetries: 0`.
function adapter(spec: string) {
  const [, provider = "", model = ""] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const id = model.trim();
  switch (provider.toLowerCase()) {
    case "openai":
      return openaiText(id as OpenAIChatModel, {
        baseURL: process.env.OPENAI_BASE_URL,
        maxRetries: 0,
      });
    case "anthropic":
      // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
      return anthropicText(id as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: 0,
      });
    case "google":
    case "gemini":
    case "google-gemini":
      // The AI SDK base URL ends in /v1beta; @google/genai adds the API version itself.
      return geminiText(id as GeminiTextModel, {
        httpOptions: {
          baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
          retryOptions: { attempts: 1 },
        },
      });
    default:
      throw new Error(
        `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini).`,
      );
  }
}

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    name: "AGUISendStateSnapshot",
    description: "Replace the entire application state with a new snapshot",
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: "AGUISendStateDelta",
    description: "Apply incremental updates to application state using JSON Patch operations",
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]).describe("The operation to perform"),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe("Array of JSON Patch operations"),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];

/** One chat turn's model, prompt and tools. The tools capture the authenticated owner. */
export interface ChatTurn {
  model: string;
  maxSteps: number;
  tools: ToolDefinition[];
  prompt: string;
}

const turns = new AsyncLocalStorage<ChatTurn>();

// The runtime hands learned-skill tools over as AI SDK tools with JSON Schema inputs.
function learnedSkillTools({ tools }: BuiltInAgentLearnedSkills) {
  return Object.entries(tools).map(([name, tool]) =>
    toolDefinition({
      name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema as { jsonSchema: JSONSchema }).jsonSchema,
    }).server((args) => tool.execute?.(args, { toolCallId: randomUUID(), messages: [] })),
  );
}

/**
 * A BuiltInAgent in TanStack factory mode with the options of the classic AI SDK mode.
 *
 * Create it once per runtime and run each turn through `chatTurn`. Clones share the
 * learned-skill registry, so the last verified snapshot is reused within the refresh window
 * and survives a transient refresh failure. Clones also share this factory, so each turn's
 * tools come from trusted server-side async context rather than shared closures.
 */
export function chatAgent(learnedSkills?: BuiltInAgentLearnedSkillsOptions) {
  return new BuiltInAgent({
    type: "tanstack",
    learnedSkills,
    factory: ({ input, abortController, learnedSkills }) => {
      const options = turns.getStore();
      if (!options) throw new Error("The chat agent must run through chatTurn");
      const converted = convertInputToTanStackAI(input);
      // Build the system prompt like the classic mode. It does not forward system messages.
      let system = options.prompt;
      if (input.context.length) {
        system += "\n## Context from the application\n";
        for (const ctx of input.context) system += `${ctx.description}:\n${ctx.value}\n`;
      }
      if (
        input.state !== undefined &&
        input.state !== null &&
        !(typeof input.state === "object" && Object.keys(input.state).length === 0)
      )
        system += `\n## Application State\nThis is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.\n\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\`\n`;
      return chat({
        adapter: adapter(options.model),
        messages: converted.messages,
        // Like the classic mode, the learned-skill catalog comes before the host prompt.
        systemPrompts: [learnedSkills.catalog, system].filter(Boolean),
        tools: [
          ...converted.tools,
          ...[...options.tools, ...stateTools].map((tool) =>
            toolDefinition({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as SchemaInput,
            }).server((args) => (tool.execute as (args: unknown) => Promise<unknown>)(args)),
          ),
          ...learnedSkillTools(learnedSkills),
        ],
        agentLoopStrategy: maxIterations(options.maxSteps),
        abortController,
      });
    },
  });
}

/** A clone of the long-lived chat agent that runs one turn with its own tools. */
export function chatTurn(agent: BuiltInAgent, turn: ChatTurn) {
  const clone = agent.clone();
  const run = clone.run.bind(clone);
  clone.run = (input: RunAgentInput) =>
    splitTextAtToolCalls(
      new Observable<BaseEvent>((subscriber) => {
        const subscription = turns.run(turn, () => run(input).subscribe(subscriber));
        return () => subscription.unsubscribe();
      }),
    );
  return clone;
}

/** A one-off agent for a single run without learned skills, such as a task-worker step. */
export function tanstackAgent(options: ChatTurn) {
  return chatTurn(chatAgent(), options);
}

// ponytail: the TanStack converter in @copilotkit/runtime 1.70.1 uses one message ID for the
// whole run. Remove this when it starts a new ID for each step, like the classic mode does.
// Text after a tool call gets a new message ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
