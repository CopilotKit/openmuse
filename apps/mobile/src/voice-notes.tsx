import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { ArrowUp, Mic, Square, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { MuseApi } from "./api";
import { colors, s } from "./ui";
import {
  extractTranscript,
  formatVoiceNoteDuration,
  type VoiceNoteUploadResult,
  voiceNoteFileIdentity,
} from "./voice-note-helpers";

type Phase = "idle" | "starting" | "recording" | "recorded" | "uploading";

function friendlyError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/permission|denied|not allowed/i.test(message))
    return Platform.OS === "web"
      ? "Microphone blocked. Voice notes need a secure (https) page or the native app."
      : "Microphone permission was denied. Enable it in system settings to record voice notes.";
  if (/10\.0\.2\.2|network|failed to fetch|load failed/i.test(message))
    return "Could not reach the server to transcribe. Check your connection and try again.";
  return message || "Something went wrong with the voice note.";
}

/** Turn a recorder output URI into a File the upload endpoint accepts. */
async function recordingUriToFile(uri: string, name: string, mime: string): Promise<File> {
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    return new File([blob], name, { type: blob.type || mime });
  }
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: mime });
}

/**
 * Mic button for the chat input row. Records a voice note, uploads it for
 * server-side transcription, then hands the transcript to the agent exactly
 * like a typed message via onTranscript.
 */
export function VoiceNoteButton({
  api,
  onTranscript,
  disabled,
}: {
  api: MuseApi;
  onTranscript: (transcript: string) => void;
  disabled?: boolean;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 500);
  const [phase, setPhase] = useState<Phase>("idle");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [recordedSeconds, setRecordedSeconds] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .request<{ available: boolean }>("/api/voice-notes/status")
      .then((r) => live && setConfigured(r.available))
      .catch(() => live && setConfigured(false));
    return () => {
      live = false;
    };
  }, [api]);

  const startRecording = useCallback(async () => {
    setError("");
    setPhase("starting");
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) throw new Error("Microphone permission denied");
      try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch {
        // Audio mode is a native concern; web recorders ignore it.
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase("recording");
    } catch (e) {
      setPhase("idle");
      setError(friendlyError(e));
    }
  }, [recorder]);

  const stopRecording = useCallback(async () => {
    try {
      setRecordedSeconds(recorderState.durationMillis / 1000);
      await recorder.stop();
      setPhase("recorded");
    } catch (e) {
      setPhase("idle");
      setError(friendlyError(e));
    }
  }, [recorder, recorderState.durationMillis]);

  const cancelRecording = useCallback(async () => {
    // Stop the active recorder first: resetting state alone would leave the
    // microphone capturing in the background.
    try {
      await recorder.stop();
    } catch {
      // Recorder was never started or already stopped; cancellation is idempotent.
    }
    setPhase("idle");
    setError("");
    setRecordedSeconds(0);
  }, [recorder]);

  const sendRecording = useCallback(async () => {
    const uri = recorder.uri;
    if (!uri) {
      setError("The recording has no audio to send.");
      setPhase("idle");
      return;
    }
    setPhase("uploading");
    setError("");
    try {
      const { name, mime } = voiceNoteFileIdentity(Platform.OS);
      const form = new FormData();
      form.append("audio", await recordingUriToFile(uri, name, mime));
      const result = await api.request<VoiceNoteUploadResult>("/api/voice-notes", form);
      onTranscript(extractTranscript(result));
      setPhase("idle");
      setRecordedSeconds(0);
    } catch (e) {
      setPhase("recorded");
      setError(friendlyError(e));
    }
  }, [api, onTranscript, recorder]);

  const busy = phase === "starting" || phase === "uploading";
  const unavailable = configured === false;

  if (phase === "recording") {
    return (
      <View style={[s.row, { gap: 8, alignItems: "center", paddingRight: 4 }]}>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: "#E5484D",
          }}
          accessibilityLabel="Recording"
        />
        <Text style={{ fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] }}>
          {formatVoiceNoteDuration(recorderState.durationMillis / 1000)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel recording"
          onPress={cancelRecording}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <X size={20} color={colors.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop recording"
          onPress={() => void stopRecording()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 24,
            backgroundColor: "#E5484D",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Square size={16} fill="#FFF" strokeWidth={0} color="#FFF" />
        </Pressable>
      </View>
    );
  }

  if (phase === "recorded" || phase === "uploading") {
    return (
      <View style={{ gap: 4 }}>
        <View style={[s.row, { gap: 8, alignItems: "center", paddingRight: 4 }]}>
          <Mic size={18} color={colors.blueDark} />
          <Text style={{ fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] }}>
            {formatVoiceNoteDuration(recordedSeconds)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard voice note"
            disabled={busy}
            onPress={cancelRecording}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <X size={20} color={colors.muted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "Transcribing voice note" : "Send voice note"}
            disabled={busy}
            onPress={() => void sendRecording()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 24,
              backgroundColor: busy ? "#F3F5F6" : colors.blue,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ArrowUp size={22} strokeWidth={1.8} color={busy ? "#9CB5C5" : colors.text} />
          </Pressable>
        </View>
        {!!error && (
          <Text style={{ fontSize: 12, color: "#B3261E", paddingHorizontal: 4 }}>{error}</Text>
        )}
      </View>
    );
  }

  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          unavailable ? "Voice notes are not set up on the server" : "Record a voice note"
        }
        disabled={disabled || busy || unavailable}
        onPress={() => void startRecording()}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 24,
          backgroundColor: pressed ? colors.sky : "transparent",
          opacity: disabled || busy || unavailable ? 0.35 : 1,
        })}
      >
        <Mic size={22} color={colors.text} strokeWidth={1.8} />
      </Pressable>
      {!!error && (
        <Text style={{ fontSize: 12, color: "#B3261E", paddingHorizontal: 4 }}>{error}</Text>
      )}
    </View>
  );
}
