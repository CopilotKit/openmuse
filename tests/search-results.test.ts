import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { SearchService, searchDescription, searchInstructions } from "../apps/server/src/search.ts";
import { searchFixture, searchSource } from "./helpers/search.ts";

const input = { objective: "Find public sources", search_queries: ["public sources"] };
async function searchPayload(t: TestContext, payload: object) {
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call" ? { result: { content: [], structuredContent: payload } } : {},
  );
  const db = await createStore();
  t.after(() => db.close());
  return new SearchService(db).search("owner", "chat:results", input);
}

test("search tool guidance is provider-neutral and retains disclosure and citation instructions", () => {
  assert.doesNotMatch(searchDescription + searchInstructions, /parallel/i);
  assert.match(searchDescription, /Queries and objective are sent to an external search service/);
  assert.match(searchDescription, /untrusted data/);
  assert.match(searchInstructions, /cite source URLs/);
});

test("search accepts HTTP and HTTPS source URLs", async (t) => {
  const sources = [searchSource, { ...searchSource, url: "http://example.org/research" }];
  assert.deepEqual(await searchPayload(t, { results: sources }), {
    provider: "parallel",
    results: sources,
    warnings: [],
    truncated: false,
  });
});

test("search drops unsafe URLs and malformed entries without discarding valid sources", async (t) => {
  const invalid = [
    { ...searchSource, url: "not a URL" },
    { ...searchSource, url: "javascript:alert(1)" },
    { ...searchSource, url: "file:///etc/passwd" },
    { ...searchSource, url: "data:text/plain,source" },
    { ...searchSource, url: "ftp://example.org/research" },
    { title: "Missing URL" },
    { ...searchSource, excerpts: [123] },
    null,
  ];
  assert.deepEqual(
    await searchPayload(t, {
      results: [...invalid.slice(0, 4), searchSource, ...invalid.slice(4)],
    }),
    {
      provider: "parallel",
      results: [searchSource],
      warnings: [`Dropped ${invalid.length} invalid search result entries`],
      truncated: true,
    },
  );
});

test("search reports all-invalid entries with bounded warnings", async (t) => {
  const result = await searchPayload(t, {
    results: [{ ...searchSource, url: "javascript:alert(1)" }, { title: "Missing URL" }],
    warnings: Array.from({ length: 12 }, () => "w".repeat(600)),
  });
  assert.deepEqual(result.results, []);
  assert.equal(result.truncated, true);
  assert.equal(result.warnings[0], "Dropped 2 invalid search result entries");
  assert.equal(result.warnings.length, 10);
  assert.ok(result.warnings.every((warning) => warning.length <= 500));
});

for (const [name, payload] of [
  ["missing results", {}],
  ["non-array results", { results: {} }],
  ["malformed warnings", { results: [searchSource], warnings: [123] }],
] as const) {
  test(`search rejects a structurally invalid payload with ${name}`, async (t) => {
    await assert.rejects(searchPayload(t, payload), /invalid search result/);
  });
}

test("search retains valid sources when the advertised output schema rejects a neighboring entry", async (t) => {
  await searchFixture(t, (rpc) => {
    if (rpc.method === "tools/list")
      return {
        result: {
          tools: [
            {
              name: "web_search",
              inputSchema: { type: "object" },
              outputSchema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["url", "excerpts"],
                      properties: {
                        url: { type: "string" },
                        excerpts: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
                required: ["results"],
              },
            },
          ],
        },
      };
    return rpc.method === "tools/call"
      ? {
          result: {
            content: [],
            structuredContent: {
              results: [
                searchSource,
                { title: "Missing URL" },
                { ...searchSource, excerpts: [123] },
              ],
            },
          },
        }
      : {};
  });
  const db = await createStore();
  t.after(() => db.close());
  assert.deepEqual(await new SearchService(db).search("owner", "chat:advertised-schema", input), {
    provider: "parallel",
    results: [searchSource],
    warnings: ["Dropped 2 invalid search result entries"],
    truncated: true,
  });
});
