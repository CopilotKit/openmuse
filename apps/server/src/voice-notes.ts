import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.ts";

const execFileAsync = promisify(execFile);

/** Max voice-note upload, 10 MB by default (override with VOICE_NOTE_MAX_BYTES). */
export const VOICE_NOTE_MAX_BYTES = 10 * 1024 * 1024;

/** Cap a single transcription run at 10 minutes; voice notes are short by design. */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

export interface TranscriptionResult {
  transcript: string;
  /** Wall-clock time the transcription itself took. */
  durationMs: number;
}

export interface Transcriber {
  /** True when the backend can run right now (binary + model present and readable). */
  available(): Promise<boolean>;
  /**
   * Transcribe a 16 kHz mono PCM WAV file. Resolves with the plain-text
   * transcript. Never logs audio bytes or model paths.
   */
  transcribe(wavPath: string): Promise<TranscriptionResult>;
}

/** Serialize transcriptions: one CPU-bound whisper run at a time. */
class TranscribeQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}

/**
 * Local CPU transcription via the whisper.cpp CLI (`whisper-cli -m <model>
 * -f <wav>`). No network, no API keys, no ports — it runs as a short-lived
 * child process per request. whisper base (~140 MB model) uses ~0.5-1 GB RSS
 * for a few seconds per minute of audio on 4 CPUs.
 */
export class WhisperCppTranscriber implements Transcriber {
  private readonly queue = new TranscribeQueue();
  constructor(
    private readonly bin: string,
    private readonly model: string,
  ) {}

  async available(): Promise<boolean> {
    try {
      await access(this.bin, constants.X_OK);
      await access(this.model, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  transcribe(wavPath: string): Promise<TranscriptionResult> {
    return this.queue.run(async () => {
      const started = Date.now();
      const threads = Math.max(1, Math.min(4, cpus().length - 1));
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          this.bin,
          ["-m", this.model, "-f", wavPath, "--no-timestamps", "-t", String(threads)],
          { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        ));
      } catch (error) {
        throw new AppError(
          `Transcription failed: ${error instanceof Error ? error.message.split("\n")[0] : "transcriber error"}`,
          502,
        );
      }
      const transcript = stdout
        .split("\n")
        .map((line) => line.replace(/^\[.*?\s*-->\s*.*?\]\s*/, "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!transcript) throw new AppError("Transcription produced no text", 502);
      return { transcript, durationMs: Date.now() - started };
    });
  }
}

/** Keep only a safe extension from the client-supplied filename. */
export function sanitizeExtension(filename: string): string {
  const base = basename(filename || "").toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = base
    .slice(dot + 1)
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return ext ? `.${ext}` : "";
}

export interface VoiceNotePipeline {
  transcriber: Transcriber;
  /** Convert any uploaded audio to 16 kHz mono PCM WAV (ffmpeg in production). */
  convertToWav: (srcPath: string, wavPath: string) => Promise<void>;
}

export async function processVoiceNote(options: {
  dataDir: string;
  file: File;
  maxBytes: number;
  pipeline: VoiceNotePipeline;
}): Promise<TranscriptionResult> {
  const { dataDir, file, maxBytes, pipeline } = options;
  const contentType = (file.type || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("audio/"))
    throw new AppError("Only audio uploads are accepted for voice notes", 400);
  if (file.size === 0) throw new AppError("The voice note is empty", 400);
  if (file.size > maxBytes)
    throw new AppError(
      `Voice note is too large (${(file.size / 1048576).toFixed(1)} MB; max ${(maxBytes / 1048576).toFixed(0)} MB)`,
      413,
    );
  if (!(await pipeline.transcriber.available()))
    throw new AppError("Voice transcription is not configured on this server", 503);

  const dir = join(dataDir, "voice-notes-tmp");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const src = join(dir, `${id}${sanitizeExtension(file.name)}`);
  const wav = join(dir, `${id}-16k.wav`);
  try {
    await writeFile(src, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
    await pipeline.convertToWav(src, wav);
    return await pipeline.transcriber.transcribe(wav);
  } finally {
    // The raw recording must never linger: it is not web-served and is
    // deleted whether transcription succeeds or fails.
    await rm(src, { force: true });
    await rm(wav, { force: true });
  }
}

/**
 * Production audio conversion: any uploaded audio/* becomes 16 kHz mono PCM
 * WAV via ffmpeg (handles the m4a from iOS/Android and webm from web
 * recorders). Requires the `ffmpeg` binary on PATH.
 */
export async function ffmpegConvertToWav(srcPath: string, wavPath: string): Promise<void> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        srcPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    throw new AppError("Could not decode the voice note audio", 422);
  }
}
