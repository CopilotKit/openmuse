import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { Config } from "./config.ts";
import { LayaClient } from "./laya.ts";

/**
 * CopilotKit tool definitions that wrap Laya classification for OpenMuse's
 * computer workspace. File contents are classified by Laya on the host GPU
 * and never enter the agent's context window — only the result (~60 bytes)
 * is returned.
 *
 * These tools are most valuable when the agent needs to scan many workspace
 * files and decide which to read fully. Instead of reading every file into
 * context (which costs ~1250 tokens per 5KB file), the agent first classifies
 * with Laya (0 tokens) and only reads relevant files.
 */

export function layaComputerTools(
  laya: LayaClient,
  options: { before?: () => Promise<void>; signal?: AbortSignal } = {},
) {
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    parameters: T,
    action: (args: z.output<T>) => Promise<unknown>,
  ) =>
    defineTool({
      name,
      description,
      parameters,
      execute: async (args) => {
        try {
          await options.before?.();
          if (options.signal?.aborted) {
            return { error: "Task was cancelled" };
          }
          return await action(parameters.parse(args));
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Laya operation failed" };
        }
      },
    });

  // The container name is internal; the agent interacts only with workspace paths.

  return [
    tool(
      "laya_classify_file",
      `Classify a single file in the computer /workspace using the Laya model on the host GPU. The file content is copied out of the container, classified by Laya, and NEVER read into the agent's context — only the yes/no result is returned. This saves ~1250 tokens per 5KB file versus reading the file. Use this before read_computer_file to decide whether a file is worth reading. Returns: { answer, confidence, noul, model, latencyMs, cached, truncated, fallback }.`,
      z.object({
        path: z
          .string()
          .min(1)
          .max(2048)
          .describe("Absolute path inside /workspace, e.g. /workspace/build.log"),
        question: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "The yes/no question to classify the file, e.g. 'Contains error or failure information?'",
          ),
        trueCriteria: z
          .string()
          .min(1)
          .max(200)
          .describe("What the 'yes' answer means, e.g. 'Yes, the file contains errors'"),
        falseCriteria: z
          .string()
          .min(1)
          .max(200)
          .describe("What the 'no' answer means, e.g. 'No, the file does not contain errors'"),
      }),
      async ({ path, question, trueCriteria, falseCriteria }) => {
        return laya.classifyComputerFile(path, question, trueCriteria, falseCriteria);
      },
    ),
    tool(
      "laya_classify_files",
      `Classify every text file under a directory in the computer /workspace. The directory is copied out of the container, and Laya classifies all files in parallel — file contents NEVER enter the agent's context. Results are sorted by confidence. Use this to triage which files to read before calling read_computer_file. Returns: array of { choice, path, confidence, probabilities, model, latencyMs, cached }.`,
      z.object({
        directory: z
          .string()
          .min(1)
          .max(2048)
          .describe("Absolute directory path inside /workspace, e.g. /workspace/src"),
        question: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "What to classify each file as, e.g. 'Which category best describes this file?'",
          ),
        options: z
          .record(z.string(), z.string().min(1).max(200))
          .describe(
            "Map of option key to human-readable label, e.g. {'config':'Configuration file','log':'Log file','code':'Source code','other':'Other'}",
          ),
      }),
      async ({ directory, question, options: opts }) => {
        return laya.classifyComputerDirectory(directory, question, opts);
      },
    ),
    tool(
      "laya_pick_file",
      `Given several workspace file paths, ask Laya to pick the single most-relevant file for a purpose. The files are copied out and classified — content does not enter the agent's context. Returns: { path, purpose, probability, model, latencyMs, cached }.`,
      z.object({
        purpose: z
          .string()
          .min(1)
          .max(500)
          .describe("What you need from the file, e.g. 'the main application entry point'"),
        paths: z
          .array(z.string().min(1).max(2048))
          .min(1)
          .max(20)
          .describe("List of absolute paths inside /workspace to choose from"),
      }),
      async ({ purpose, paths }) => {
        return laya.pickFromComputerFiles(purpose, paths);
      },
    ),
    tool(
      "laya_status",
      "Check the Laya classification service health and cache stats. Shows tunnel status, model info, and cache hit/miss counts.",
      z.object({}),
      async () => {
        return laya.status();
      },
    ),
    tool(
      "laya_clear_cache",
      "Clear all cached Laya classification results. Use after modifying workspace files to force re-classification on the next call.",
      z.object({}),
      async () => {
        return laya.clearCache();
      },
    ),
  ];
}

/** Create a LayaClient from config + owner, or null if Laya is not configured. */
export function tryCreateLayaClient(config: Config, owner: string): LayaClient | null {
  if (!process.env.LAYA_ENABLED) return null;
  return new LayaClient(config, owner);
}
