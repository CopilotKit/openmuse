import * as FileSystem from "expo-file-system/legacy";
import type { Storage } from "./onboarding-telemetry";

function path() {
  if (!FileSystem.documentDirectory) throw Error("Persistence unavailable");
  return `${FileSystem.documentDirectory}openmuse-onboarding.json`;
}
export const onboardingStorage: Storage = {
  read: async () => {
    const file = path();
    return (await FileSystem.getInfoAsync(file)).exists ? FileSystem.readAsStringAsync(file) : null;
  },
  write: async (value) => {
    const file = path(),
      temporary = `${file}.tmp`;
    await FileSystem.writeAsStringAsync(temporary, value);
    await FileSystem.moveAsync({ from: temporary, to: file });
  },
  remove: async () => {
    await FileSystem.deleteAsync(path(), { idempotent: true });
    await FileSystem.deleteAsync(`${path()}.tmp`, { idempotent: true });
  },
};
