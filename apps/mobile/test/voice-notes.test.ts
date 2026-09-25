import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractTranscript,
  formatVoiceNoteDuration,
  voiceNoteFileIdentity,
  voiceNoteUserMessage,
} from "../src/voice-note-helpers.ts";

test("formats recording durations as m:ss", () => {
  assert.equal(formatVoiceNoteDuration(0), "0:00");
  assert.equal(formatVoiceNoteDuration(7.4), "0:07");
  assert.equal(formatVoiceNoteDuration(65), "1:05");
  assert.equal(formatVoiceNoteDuration(-3), "0:00");
});

test("extracts the transcript and rejects empty results", () => {
  assert.equal(extractTranscript({ transcript: "  hello  ", durationMs: 3 }), "hello");
  assert.throws(() => extractTranscript({ transcript: "   " }), /empty/i);
  assert.throws(() => extractTranscript({}), /empty/i);
  assert.throws(() => extractTranscript(null), /empty/i);
});

test("transcript becomes a user message for the agent pipeline", () => {
  // The transcript is fed to the agent exactly as if the user had typed it:
  // a plain user-role message whose content is the transcript.
  const message = voiceNoteUserMessage("remind me at five");
  assert.deepEqual(message, { role: "user", content: "remind me at five" });
});

test("picks a container filename per platform", () => {
  const web = voiceNoteFileIdentity("web");
  assert.match(web.name, /\.webm$/);
  assert.equal(web.mime, "audio/webm");
  const ios = voiceNoteFileIdentity("ios");
  assert.match(ios.name, /\.m4a$/);
  assert.equal(ios.mime, "audio/mp4");
});
