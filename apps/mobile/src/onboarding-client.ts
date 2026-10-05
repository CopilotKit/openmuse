import "react-native-get-random-values";
import { AppState, Platform } from "react-native";
import config from "../app.json";
import { onboardingStorage } from "./onboarding-storage";
import { createOnboardingTelemetry, platformSchema } from "./onboarding-telemetry";

let session: { token: string; url: string } | undefined;
const controllers = new Set<AbortController>();
export function clientTelemetryDisabled() {
  return (
    ["true", "1"].includes(process.env.EXPO_PUBLIC_COPILOTKIT_TELEMETRY_DISABLED || "") ||
    (Platform.OS === "web" &&
      (globalThis.navigator?.doNotTrack === "1" ||
        (typeof window !== "undefined" && "doNotTrack" in window && window.doNotTrack === "1")))
  );
}
function randomUUID() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function request(url: string, init: RequestInit) {
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
  }
}
export const onboarding = createOnboardingTelemetry({
  storage: onboardingStorage,
  randomUUID,
  now: Date.now,
  disabled: clientTelemetryDisabled,
  platform: platformSchema.parse(Platform.OS),
  version: config.expo.version,
  send: async (id, event) =>
    (
      await request(
        process.env.EXPO_PUBLIC_COPILOTKIT_TELEMETRY_URL ||
          "https://telemetry.copilotkit.ai/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CopilotKit-Telemetry-Id": id },
          body: JSON.stringify(event),
        },
      )
    ).status,
  linkReady: () => Boolean(session),
  link: async (body) => {
    if (!session) throw Error("No session");
    const response = await request(`${session.url}/api/telemetry/onboarding-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Error("Link unavailable");
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("enabled" in result) ||
      typeof result.enabled !== "boolean" ||
      !("linked" in result) ||
      typeof result.linked !== "boolean"
    )
      throw Error("Invalid response");
    return { enabled: result.enabled, linked: result.linked };
  },
});
export async function authenticatedOnboarding(token: string, url: string, enabled: boolean) {
  if (!enabled || clientTelemetryDisabled()) {
    session = undefined;
    for (const c of controllers) c.abort();
    await onboarding.disable();
    return;
  }
  session = { token, url };
  await onboarding.linkSession();
  void onboarding.flush();
}
export function observeOnboarding() {
  void onboarding.start();
  const listener = AppState.addEventListener("change", (state) => {
    if (state === "active") void onboarding.flush();
  });
  const hide = () => void onboarding.flush();
  if (Platform.OS === "web") window.addEventListener("pagehide", hide);
  return () => {
    listener.remove();
    if (Platform.OS === "web") window.removeEventListener("pagehide", hide);
  };
}
