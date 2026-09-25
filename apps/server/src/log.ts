/** Background errors are visible without logging provider payloads or credential-bearing URLs. */
export function backgroundFailure(phase: string, error: unknown) {
  console.error({
    timestamp: new Date().toISOString(),
    context: { phase },
    error: error instanceof Error ? error.name : "Background operation failed",
  });
}
