import { z } from "zod";
import { PROVIDER_CATALOG, type ProviderId } from "../../engine/providers.ts";

export const providerIdSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "mistral",
  "custom",
  "local",
]);

const catalogFor = (provider: ProviderId) =>
  PROVIDER_CATALOG.find((entry) => entry.id === provider);

const baseUrlShape = z.string().trim().max(500);

function checkCreate(
  value: {
    provider: ProviderId;
    baseUrl?: string;
    apiKey?: string;
  },
  ctx: z.RefinementCtx,
): void {
  const entry = catalogFor(value.provider);
  if (!entry) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown provider" });
    return;
  }
  if (entry.keyRequired && !value.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${entry.displayName} requires an API key`,
      path: ["apiKey"],
    });
  }
  if (value.provider === "local" && value.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Local (Ollama) entries use no API key",
      path: ["apiKey"],
    });
  }
  if (value.provider === "custom" && !value.baseUrl?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Custom providers require a baseUrl",
      path: ["baseUrl"],
    });
  }
  if (value.baseUrl?.trim() && !/^https?:\/\/[^/\s]+/.test(value.baseUrl.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "baseUrl must be an http(s) URL",
      path: ["baseUrl"],
    });
  }
}

export const providerKeyCreateSchema = z
  .object({
    provider: providerIdSchema,
    label: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    baseUrl: baseUrlShape.optional(),
    apiKey: z.string().min(1).max(10000).optional(),
  })
  .superRefine(checkCreate);

export const providerKeyUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    baseUrl: baseUrlShape.optional(),
    apiKey: z.string().min(1).max(10000).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export type ProviderKeyCreate = z.input<typeof providerKeyCreateSchema>;
export type ProviderKeyUpdate = z.infer<typeof providerKeyUpdateSchema>;
