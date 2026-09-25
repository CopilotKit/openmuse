import { z } from "zod";
import { messageIdSchema } from "../../../../../packages/domain/src/index.ts";

/**
 * Mail server host. Must be a plain public DNS hostname — no scheme, port,
 * path, spaces, or IP literal. Private/reserved names are rejected so a
 * connector can never be pointed at an internal loopback/RFC1918 service
 * when an attacker can create an account (SSRF guard). The exact casing
 * rules mirror DNS labels: letters, digits, and hyphens per label.
 */
const MAIL_HOST_PATTERN =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE_OCTET = /^(10\.|127\.|192\.168\.|169\.254\.)/;
const PRIVATE_LINK = /(\.local|\.internal|\.lan|\.home|\.onion|\.localdomain)$/i;
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => MAIL_HOST_PATTERN.test(value) && !value.includes(":"), {
    message:
      "Host must be a public DNS hostname like imap.example.com — no scheme, port, spaces, or IP addresses.",
  })
  .refine(
    (value) =>
      !IPV4_LITERAL.test(value) &&
      !PRIVATE_OCTET.test(value) &&
      !/^localhost(\.|$)/i.test(value) &&
      !PRIVATE_LINK.test(value),
    { message: "Local, reserved, and private-network mail hosts are not allowed." },
  );
const port = z.number().int().min(1).max(65535);

export const emailAccountCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  emailAddress: z.email().max(320),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4096),
  imapHost: host,
  imapPort: port.default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: host,
  smtpPort: port.default(465),
  smtpSecure: z.boolean().default(true),
});

export const emailAccountUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    emailAddress: z.email().max(320).optional(),
    username: z.string().trim().min(1).max(320).optional(),
    password: z.string().min(1).max(4096).optional(),
    imapHost: host.optional(),
    imapPort: port.optional(),
    imapSecure: z.boolean().optional(),
    smtpHost: host.optional(),
    smtpPort: port.optional(),
    smtpSecure: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const emailMessageQuerySchema = z.object({
  folder: z.string().min(1).max(256).default("INBOX"),
  query: z.string().trim().max(500).default(""),
  // 1-based page; pageSize capped so one request cannot pull the whole mailbox.
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const emailSendSchema = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be a single line"),
  body: z.string().min(1).max(100000),
  inReplyTo: messageIdSchema.optional(),
});

export type EmailAccountCreate = z.input<typeof emailAccountCreateSchema>;
export type EmailAccountUpdate = z.infer<typeof emailAccountUpdateSchema>;

/**
 * Compose-box AI helpers. Both are bounded so one request cannot burn
 * through the model budget; the raw chat call truncates again defensively.
 */
export const aiReplySchema = z.object({
  from: z.string().trim().min(1).max(320),
  sender: z.string().trim().max(320).optional(),
  subject: z.string().trim().max(998).default(""),
  body: z.string().trim().min(1).max(6000),
});

export const fixGrammarSchema = z.object({
  text: z.string().trim().min(1).max(6000),
});
