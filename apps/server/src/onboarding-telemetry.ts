import { z } from "zod";
import { AppError } from "./errors.ts";

const bodySchema = z
  .object({
    installation_id: z.string().uuid(),
    event_id: z.string().uuid(),
    platform: z.enum(["web", "ios", "android"]),
    app_version: z
      .string()
      .max(32)
      .regex(/^\d+(?:\.\d+){1,3}$/),
  })
  .strict();
export function onboardingEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (
    ![env.DO_NOT_TRACK, env.COPILOTKIT_TELEMETRY_DISABLED].some((v) => v === "true" || v === "1") &&
    !(
      env.COPILOTKIT_TELEMETRY_SAMPLE_RATE?.trim() &&
      Number(env.COPILOTKIT_TELEMETRY_SAMPLE_RATE) === 0
    )
  );
}
export async function linkOnboarding(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  const body = bodySchema.parse(input);
  if (!onboardingEnabled(env)) return { enabled: false, linked: false };
  const project = env.CPK_TELEMETRY_ID?.trim();
  if (!project || !/^[A-Za-z0-9_-]{1,128}$/.test(project)) return { enabled: true, linked: false };
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(
      env.COPILOTKIT_TELEMETRY_URL || "https://telemetry.copilotkit.ai/ingest",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CopilotKit-Telemetry-Id": project },
        signal: controller.signal,
        body: JSON.stringify({
          event: "oss.onboarding.identity_linked",
          event_id: body.event_id,
          properties: { installation_id: body.installation_id, project_telemetry_id: project },
          global_properties: {
            accessibility_title: "OpenMuse",
            platform: body.platform,
            app_version: body.app_version,
          },
          package: { name: "openmuse-server", version: body.app_version },
          ts: Math.floor(Date.now() / 1000),
        }),
      },
    );
    if (!response.ok) throw Error();
    return { enabled: true, linked: true };
  } catch {
    throw new AppError("Telemetry temporarily unavailable", 503);
  } finally {
    clearTimeout(timer);
  }
}
