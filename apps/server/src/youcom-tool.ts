import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";

const YOUCOM_BASE = "https://api.you.com/v1";

export interface YoucomOptions {
  apiKey: string;
}

/**
 * Build the optional You.com search tool.
 *
 * Registered only when YOUCOM_API_KEY is set.
 * Uses the You.com Search API to return web results alongside the
 * existing browse_web tool — search first, then browse.
 */
export function youcomTools(options: YoucomOptions) {
  const { apiKey } = options;

  return defineTool({
    name: "search_web",
    description:
      "Search the web using You.com. Returns up to 10 ranked results with titles, URLs, and snippets. " +
      "Use this before browse_web when you need to find relevant pages, then open the best result. " +
      "Each result includes a published date and source domain.",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .max(500)
        .describe("The search query, plain text. Use natural language."),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Number of results to return (1–10, default 5)."),
    }),
    execute: async ({ query, count }) => {
      try {
        const params = new URLSearchParams({ query, count: String(count) });
        const response = await fetch(`${YOUCOM_BASE}/search?${params}`, {
          headers: {
            "X-API-Key": apiKey,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return {
            error: `You.com API returned ${response.status}: ${body.slice(0, 500)}`,
          };
        }

        const data = (await response.json()) as {
          results?: Array<{
            title: string;
            url: string;
            snippet: string;
            published_date?: string;
            source?: string;
          }>;
        };

        if (!data.results?.length) {
          return {
            query,
            results: [],
            message: "No results found for this query.",
          };
        }

        return {
          query,
          results: data.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            publishedDate: r.published_date ?? null,
            source: r.source ?? null,
          })),
          total: data.results.length,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { error: "Search request timed out after 15 seconds." };
        }
        return {
          error:
            error instanceof Error
              ? error.message
              : "Search failed for an unknown reason.",
        };
      }
    },
  });
}