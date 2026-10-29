import assert from "node:assert/strict";
import test from "node:test";
import { GoogleClient } from "../packages/integrations/src/google.ts";

test("invalid Gmail dates do not prevent inbox and thread reads", async () => {
  for (const internalDate of ["8640000000000001", "-8640000000000001", "1e100", "invalid"]) {
    const messages = [
      { id: "invalid-date", threadId: "thread1", internalDate, snippet: "Still readable" },
      { id: "valid-date", threadId: "thread1", internalDate: "1791658800000" },
    ];
    const client = new GoogleClient({
      getAccessToken: async () => "synthetic-access-token",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/messages"))
          return Response.json({ messages: messages.map(({ id }) => ({ id })) });
        if (path.includes("/threads/")) return Response.json({ id: "thread1", messages });
        const message = messages.find(({ id }) => path.endsWith(`/${id}`));
        assert.ok(message);
        return Response.json(message);
      },
    });
    for (const mails of [await client.listMail(), await client.getThread("thread1")]) {
      assert.equal(mails.length, 2);
      assert.equal(mails[0].body, "Still readable");
      assert.equal(mails[0].date, "");
      assert.equal(mails[1].date, "2026-10-10T19:00:00.000Z");
    }
  }
});

test("Gmail dates retain valid epoch, date limits and Date-header fallback", async () => {
  for (const [internalDate, expected] of [
    ["0", "1970-01-01T00:00:00.000Z"],
    ["8640000000000000", "+275760-09-13T00:00:00.000Z"],
    ["-8640000000000000", "-271821-04-20T00:00:00.000Z"],
    [undefined, "2026-10-10T19:00:00.000Z"],
  ]) {
    const client = new GoogleClient({
      getAccessToken: async () => "synthetic-access-token",
      fetch: async () =>
        Response.json({
          id: "thread1",
          messages: [
            {
              id: "message1",
              threadId: "thread1",
              internalDate,
              payload: { headers: [{ name: "Date", value: "Sat, 10 Oct 2026 19:00:00 GMT" }] },
            },
          ],
        }),
    });
    assert.equal((await client.getThread("thread1"))[0].date, expected);
  }
});
