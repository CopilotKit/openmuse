import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  sanitizeExtension,
  type TranscriptionResult,
  VOICE_NOTE_MAX_BYTES,
} from "../apps/server/src/voice-notes.ts";

let db: Store;
let directory: string;
let token: string;
type App = Awaited<ReturnType<typeof createApp>>["app"];
let app: App; // no transcriber configured -> 503 path
let appWithStub: App; // stub transcriber -> success path

const stubTranscript = "hello from the voice note";
const stub: { transcribe: (wavPath: string) => Promise<TranscriptionResult> } = {
  transcribe: async (wavPath: string) => {
    assert.match(wavPath, /\.wav$/);
    return { transcript: stubTranscript, durationMs: 7 };
  },
};

function testConfig(): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
}

function audioFile(
  bytes: Uint8Array<ArrayBuffer>,
  name = "note.m4a",
  type = "audio/mp4",
): FormData {
  const form = new FormData();
  form.append("audio", new File([bytes], name, { type }));
  return form;
}

const authHeaders = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-voice-"));
  db = await createStore();
  ({ app } = await createApp(db, testConfig()));
  ({ app: appWithStub } = await createApp(db, testConfig(), {
    voiceNotes: {
      transcriber: {
        available: async () => true,
        transcribe: stub.transcribe,
      },
      convertToWav: async () => {},
    },
  }));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("voice notes require authentication", async () => {
  assert.equal((await app.request("/api/voice-notes/status")).status, 401);
  assert.equal(
    (
      await app.request("/api/voice-notes", {
        method: "POST",
        body: audioFile(new Uint8Array([1, 2, 3])),
      })
    ).status,
    401,
  );
});

test("status reports transcription availability", async () => {
  const none = await app.request("/api/voice-notes/status", { headers: authHeaders() });
  assert.equal(none.status, 200);
  assert.equal((await none.json()).available, false);
  const yes = await appWithStub.request("/api/voice-notes/status", { headers: authHeaders() });
  assert.equal(yes.status, 200);
  assert.equal((await yes.json()).available, true);
});

test("voice notes reject non-audio uploads", async () => {
  const form = new FormData();
  form.append("audio", new File(["not audio"], "note.txt", { type: "text/plain" }));
  const response = await appWithStub.request("/api/voice-notes", {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /audio/i);
});

test("voice notes reject empty uploads", async () => {
  const response = await appWithStub.request("/api/voice-notes", {
    method: "POST",
    headers: authHeaders(),
    body: audioFile(new Uint8Array(0)),
  });
  assert.equal(response.status, 400);
});

test("voice notes reject oversized uploads", async () => {
  const big = new Uint8Array(VOICE_NOTE_MAX_BYTES + 1);
  const response = await appWithStub.request("/api/voice-notes", {
    method: "POST",
    headers: authHeaders(),
    body: audioFile(big),
  });
  assert.equal(response.status, 413);
});

test("voice notes require the audio form field", async () => {
  const response = await appWithStub.request("/api/voice-notes", {
    method: "POST",
    headers: authHeaders(),
    body: new FormData(),
  });
  assert.equal(response.status, 400);
});

test("voice notes are 503 when no transcriber is configured", async () => {
  const response = await app.request("/api/voice-notes", {
    method: "POST",
    headers: authHeaders(),
    body: audioFile(new Uint8Array([1, 2, 3, 4])),
  });
  assert.equal(response.status, 503);
});

test("voice note transcribes and cleans up temp files", async () => {
  const response = await appWithStub.request("/api/voice-notes", {
    method: "POST",
    headers: authHeaders(),
    body: audioFile(new Uint8Array([1, 2, 3, 4]), "../../evil.m4a"),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.transcript, stubTranscript);
  assert.equal(typeof payload.durationMs, "number");
  // Raw audio must not linger in the temp dir (path traversal name included).
  const leftovers = await readdir(join(directory, "voice-notes-tmp")).catch(() => []);
  assert.deepEqual(leftovers, []);
});

test("sanitizeExtension keeps only safe extensions", async () => {
  assert.equal(sanitizeExtension("note.m4a"), ".m4a");
  assert.equal(sanitizeExtension("../../etc/passwd"), "");
  assert.equal(sanitizeExtension("note.MP3"), ".mp3");
  assert.equal(sanitizeExtension("note"), "");
  assert.equal(sanitizeExtension("note.we!ird"), ".weird");
});
