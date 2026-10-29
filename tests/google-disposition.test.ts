import assert from "node:assert/strict";
import test from "node:test";
import { GoogleClient } from "../packages/integrations/src/google.ts";

const encoded = (text: string) => Buffer.from(text).toString("base64url");

test("unnamed explicit attachments stay lazy and separate from the parent body", async () => {
  for (const [mimeType, embedded] of [
    ["text/plain", false],
    ["text/plain", true],
    ["text/html", false],
    ["multipart/mixed", false],
  ] as const) {
    const message = {
      id: "outer",
      threadId: "thread1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: encoded("Outer body.") } },
          {
            mimeType,
            headers: [
              { name: "Content-Disposition", value: " Attachment ; creation-date=ignored" },
            ],
            body: {
              attachmentId: "attached",
              size: 42,
              ...(embedded ? { data: encoded("Attached text.") } : {}),
            },
            parts: [{ mimeType: "text/plain", body: { data: encoded("Attached text.") } }],
          },
        ],
      },
    };
    const client = new GoogleClient({
      getAccessToken: async () => "synthetic-access-token",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        assert.ok(!path.includes("/attachments/"), "opening mail must not fetch an attachment");
        if (path.endsWith("/messages")) return Response.json({ messages: [{ id: "outer" }] });
        if (path.includes("/threads/"))
          return Response.json({ id: "thread1", messages: [message] });
        return Response.json(message);
      },
    });
    for (const mails of [await client.listMail(), await client.getThread("thread1")]) {
      assert.equal(mails[0].body, "Outer body.");
      assert.deepEqual(mails[0].attachments, ["outer:attached:attachment"]);
    }
  }
});

test("inline remote text remains body content instead of an attachment", async () => {
  for (const disposition of [undefined, "inline", "attachment-preview"]) {
    const message = {
      id: "outer",
      threadId: "thread1",
      payload: {
        mimeType: "text/plain",
        headers: disposition ? [{ name: "Content-Disposition", value: disposition }] : [],
        body: { attachmentId: "body1", size: 11 },
      },
    };
    const client = new GoogleClient({
      getAccessToken: async () => "synthetic-access-token",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/attachments/body1"))
          return Response.json({ data: encoded("Inline body"), size: 11 });
        return Response.json({ id: "thread1", messages: [message] });
      },
    });
    const [mail] = await client.getThread("thread1");
    assert.equal(mail.body, "Inline body");
    assert.deepEqual(mail.attachments, []);
  }
});
