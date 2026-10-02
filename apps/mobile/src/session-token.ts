const key = "openmuse.session";

function browserStorage(): Storage | undefined {
  try {
    // Native builds have no browser storage. Their session stays in memory, which is
    // enough because a native app is not reloaded the way a page is.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Browsers throw on storage access when cookies or site data are blocked.
    return undefined;
  }
}

export function storedSessionToken(): string {
  try {
    return browserStorage()?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function rememberSessionToken(token: string): void {
  try {
    browserStorage()?.setItem(key, token);
  } catch {
    // A full or read-only store must not stop the workspace from opening. The next
    // reload asks for the access key again instead of failing here.
  }
}

export function forgetSessionToken(): void {
  try {
    browserStorage()?.removeItem(key);
  } catch {
    // Nothing to clear when the store is unavailable.
  }
}
