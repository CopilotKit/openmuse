import { z } from "zod";

const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const ipv4 =
  "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}";
const hostnamePattern = new RegExp(
  `^(localhost|${ipv4}|\\[[0-9a-fA-F:]+\\]|[0-9a-fA-F:]*:[0-9a-fA-F:]+|${label}(\\.${label})*)$`,
);

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => {
    // Tolerate a pasted URL; only the hostname is kept.
    const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`;
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  })
  .refine((value) => hostnamePattern.test(value), {
    message: "Domain must be a valid hostname like accounts.example.com",
  });

export const credentialCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  domain: hostname,
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4096),
});

export const credentialUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    domain: hostname.optional(),
    username: z.string().trim().min(1).max(320).optional(),
    password: z.string().min(1).max(4096).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const credentialLoginSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

export const credentialLoginAutoSchema = z.object({
  sessionId: z.string().min(1).max(200),
  /** Optional: skip auto-match and use this exact saved login by label. */
  label: z.string().trim().min(1).max(120).optional(),
});

export type CredentialCreate = z.infer<typeof credentialCreateSchema>;
export type CredentialUpdate = z.infer<typeof credentialUpdateSchema>;
