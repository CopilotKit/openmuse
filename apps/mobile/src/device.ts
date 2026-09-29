import { Platform } from "react-native";
import "react-native-get-random-values";

/**
 * Generate and cache a per-installation device identifier.
 * On first run, a random UUID is generated; on subsequent calls
 * the same value is returned for the lifetime of the JS context.
 *
 * In a production build you would persist this to SecureStore so
 * the device ID survives app restarts. For now, a random UUID is
 * sufficient: it changes when the app fully restarts, which still
 * lets the server distinguish "this device" for the current session.
 */
let cachedDeviceId: string | null = null;
export function deviceId(): string {
  if (!cachedDeviceId) cachedDeviceId = crypto.randomUUID();
  return cachedDeviceId;
}
/** A human-readable label for this device/installation. */
export function deviceName(): string {
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
  return `${os} companion`;
}
export function deviceInfo(): { deviceId: string; deviceName: string } {
  return { deviceId: deviceId(), deviceName: deviceName() };
}
