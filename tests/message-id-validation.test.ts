import assert from "node:assert/strict";
import test from "node:test";
import { emailSendSchema } from "../apps/server/src/connectors/email/schemas.ts";
import { emailDraftSchema, messageIdSchema } from "../packages/domain/src/index.ts";

test("messageIdSchema accepts a valid Message-ID", () => {
  assert.equal(messageIdSchema.parse("<abc@def.com>"), "<abc@def.com>");
});

test("messageIdSchema rejects header-injection payloads", () => {
  for (const value of [
    "<abc@def.com>\r\nBcc: intruder@evil.example",
    "<abc@def.com>\nBcc: intruder@evil.example",
    "<abc@def.com>\rX-Injected: yes",
  ]) {
    assert.throws(() => messageIdSchema.parse(value), /Invalid Message-ID/, value);
  }
});

test("messageIdSchema rejects malformed values", () => {
  for (const value of [
    "abc@def.com", // missing angle brackets
    "<abc def@def.com>", // whitespace
    "<a\tb@c.com>", // tab
    "<>", // empty
    "<@>", // missing local and domain parts
    "<abc@def.com> trailing", // trailing junk
  ]) {
    assert.throws(() => messageIdSchema.parse(value));
  }
});

test("messageIdSchema enforces the 998-char limit", () => {
  const atLimit = `<${"a".repeat(991)}@b.co>`;
  assert.equal(atLimit.length, 998);
  assert.equal(messageIdSchema.parse(atLimit), atLimit);
  const overLimit = `<${"a".repeat(995)}@b.co>`;
  assert.ok(overLimit.length > 998);
  assert.throws(() => messageIdSchema.parse(overLimit));
});

test("emailSendSchema requires a strict Message-ID for inReplyTo", () => {
  const base = { to: ["sam@example.com"], subject: "Re: Hi", body: "Hello" };
  const parsed = emailSendSchema.parse({ ...base, inReplyTo: "<abc@def.com>" });
  assert.equal(parsed.inReplyTo, "<abc@def.com>");
  assert.throws(
    () => emailSendSchema.parse({ ...base, inReplyTo: "<abc@def.com>\r\nBcc: x@evil.example" }),
    /Invalid Message-ID/,
  );
  assert.throws(() => emailSendSchema.parse({ ...base, inReplyTo: "not-a-message-id" }));
  // inReplyTo stays optional.
  assert.equal(emailSendSchema.parse(base).inReplyTo, undefined);
});

test("emailDraftSchema replyToMessageId rejects line breaks but keeps backend ids working", () => {
  const base = { to: ["sam@example.com"], subject: "Re: Hi", body: "Hello" };
  // Gmail resource ids (pinned through idPath() in the Gmail connector) still validate.
  assert.equal(
    emailDraftSchema.parse({ ...base, replyToMessageId: "18d3f2a1b2c3d4e5" }).replyToMessageId,
    "18d3f2a1b2c3d4e5",
  );
  // IMAP "folder:uid" ids (from imapToMail) still validate.
  assert.equal(
    emailDraftSchema.parse({ ...base, replyToMessageId: "INBOX:123" }).replyToMessageId,
    "INBOX:123",
  );
  // Header injection is rejected at the domain boundary.
  assert.throws(
    () => emailDraftSchema.parse({ ...base, replyToMessageId: "<a@b>\r\nBcc: x@evil.example" }),
    /line breaks/,
  );
  // The field stays optional.
  assert.equal(emailDraftSchema.parse(base).replyToMessageId, undefined);
});
