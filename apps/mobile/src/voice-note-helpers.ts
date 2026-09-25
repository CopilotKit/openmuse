/**
 * Pure helpers for the voice-note flow. Kept free of React Native imports so
 * they can be unit-tested with plain node.
 */

/** Format a duration in seconds as m:ss for the recording timer. */
export function formatVoiceNoteDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface VoiceNoteUploadResult {
  transcript: string;
  durationMs: number;
}

/**
 * Validate the POST /api/voice-notes response and pull out the transcript.
 * Throws a user-facing message when transcription came back empty.
 */
export function extractTranscript(result: unknown): string {
  const transcript = (result as { transcript?: unknown } | null | undefined)?.transcript;
  if (typeof transcript !== "string" || !transcript.trim())
    throw new Error("Transcription came back empty. Try recording again.");
  return transcript.trim();
}

/**
 * The transcript enters the agent message pipeline exactly like a typed
 * message: a plain user-role message with the transcript as content.
 */
export function voiceNoteUserMessage(transcript: string): { role: "user"; content: string } {
  return { role: "user", content: transcript };
}

/** Pick a container filename/mime for the platform's recorder output. */
export function voiceNoteFileIdentity(platform: string): { name: string; mime: string } {
  const stamp = Date.now().toString(36);
  if (platform === "web") return { name: `voice-note-${stamp}.webm`, mime: "audio/webm" };
  if (platform === "android") return { name: `voice-note-${stamp}.m4a`, mime: "audio/mp4" };
  return { name: `voice-note-${stamp}.m4a`, mime: "audio/mp4" };
}
