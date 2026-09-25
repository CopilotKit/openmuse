/** Background errors are visible without logging provider payloads or credential-bearing URLs. */
export function backgroundFailure(phase: string, error: unknown) {
  const rawCode =
    error instanceof Error && "code" in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : undefined;
  console.error({
    timestamp: new Date().toISOString(),
    context: { phase },
    error: error instanceof Error ? error.name : "Background operation failed",
    ...(code ? { code } : {}),
  });
}

/** Provider failures keep status and request ID for support, never bodies or credentials. */
export function providerFailure(phase: string, error: unknown) {
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  console.error({
    timestamp: new Date().toISOString(),
    context: {
      phase,
      ...(typeof detail.status === "number" ? { status: detail.status } : {}),
      ...(typeof detail.requestId === "string" ? { requestId: detail.requestId } : {}),
    },
    error: error instanceof Error ? error.name : "Provider request failed",
  });
}
