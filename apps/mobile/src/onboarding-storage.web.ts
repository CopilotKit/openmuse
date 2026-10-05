import type { Storage } from "./onboarding-telemetry";

const key = "openmuse.onboarding.v1";
export const onboardingStorage: Storage = {
  read: async () => localStorage.getItem(key),
  write: async (value) => localStorage.setItem(key, value),
  remove: async () => localStorage.removeItem(key),
};
