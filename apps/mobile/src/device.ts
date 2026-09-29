import { Platform } from "react-native";
import "react-native-get-random-values";
import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "openmuse.deviceId";
/**
 * Device identifier for model-routing overrides.
 *
 * On native platforms, a random UUID is generated on first launch and
 * persisted to expo-secure-store so it survives app restarts. On web
 * (where SecureStore is unavailable) the UUID is ephemeral per JS
 * context — sufficient for current-session routing.
 */
let cachedDeviceId: string | null = null;
export async function deviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  if (Platform.OS === "web") {
    cachedDeviceId = crypto.randomUUID();
    return cachedDeviceId;
  }
  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  cachedDeviceId = stored ?? crypto.randomUUID();
  if (!stored) await SecureStore.setItemAsync(DEVICE_ID_KEY, cachedDeviceId);
  return cachedDeviceId;
}
/** A human-readable label for this device/installation. */
export function deviceName(): string {
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
  return `${os} companion`;
}
export async function deviceInfo(): Promise<{ deviceId: string; deviceName: string }> {
  return { deviceId: await deviceId(), deviceName: deviceName() };
}
