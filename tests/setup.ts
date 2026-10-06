// Unit/API fixtures must never emit production SDK telemetry.
// Telemetry tests exercise enabled behavior in isolated child processes.
process.env.DO_NOT_TRACK = "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
