import {
  AlertTriangle,
  Check,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MuseApi } from "./api";
import { Button, Card, colors, Empty, ErrorNotice, Field, SectionHeading, Sheet, s } from "./ui";

/**
 * Models & API keys — manage LLM provider keys and pick the model the agent
 * runs on.
 *
 * SECURITY: API keys are write-only. They are sent only on create and on
 * explicit rotation; list/selection responses carry the masked keyHint
 * ("…abcd") and never the secret. Test diagnostics are server-sanitised and
 * rendered as-is. Nothing here renders, logs, or stores a key value.
 *
 * Mounted in the Connections settings screen (screens.tsx) as the
 * "Models & API keys" section; this file stays self-contained (no
 * connectors-client edits needed).
 */

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "xai"
  | "mistral"
  | "custom"
  | "local";

export interface ProviderCatalogEntry {
  id: ProviderId;
  displayName: string;
  defaultBaseUrl?: string;
  defaultModel: string;
  sdkPrefix: "openai" | "anthropic" | "google";
  keyRequired: boolean;
  agentChatSupported: boolean;
  agentChatNote?: string;
}

export interface ProviderKeyMeta {
  id: string;
  provider: ProviderId;
  label: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
  /** Masked hint, e.g. "…abcd" — safe to display. */
  keyHint: string;
  selected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderKeyInput {
  provider: ProviderId;
  label: string;
  model: string;
  baseUrl?: string;
  /** Write-only: sent on create / rotation, never read back. */
  apiKey?: string;
}

export interface ProviderTest {
  ok: boolean;
  detail?: string;
}

const BASE = "/api/provider-keys";

function requestMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Request failed";
}

async function listProviders(api: MuseApi): Promise<ProviderKeyMeta[]> {
  return api.request<ProviderKeyMeta[]>(BASE);
}
async function loadCatalog(api: MuseApi): Promise<ProviderCatalogEntry[]> {
  return api.request<ProviderCatalogEntry[]>(`${BASE}/catalog`);
}
async function createProvider(api: MuseApi, input: ProviderKeyInput): Promise<ProviderKeyMeta> {
  return api.request<ProviderKeyMeta>(BASE, input, "POST");
}
async function updateProvider(
  api: MuseApi,
  id: string,
  patch: Partial<ProviderKeyInput>,
): Promise<ProviderKeyMeta> {
  return api.request<ProviderKeyMeta>(`${BASE}/${id}`, patch, "PATCH");
}
async function deleteProvider(api: MuseApi, id: string): Promise<void> {
  await api.request<{ ok: true }>(`${BASE}/${id}`, undefined, "DELETE");
}
async function selectProvider(api: MuseApi, id: string): Promise<ProviderKeyMeta> {
  return api.request<ProviderKeyMeta>(`${BASE}/${id}/select`, {}, "POST");
}
async function testProvider(api: MuseApi, id: string): Promise<ProviderTest> {
  return api.request<ProviderTest>(`${BASE}/${id}/test`, {}, "POST");
}

function ProviderName({ entry }: { entry?: ProviderCatalogEntry }) {
  if (!entry) return null;
  return (
    <Text style={[s.small, { color: colors.muted }]}>
      {entry.displayName}
      {entry.agentChatSupported ? "" : " · stored only — agent chat not supported"}
    </Text>
  );
}

interface FormState {
  provider: ProviderId;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

function ProviderForm({
  catalog,
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  catalog: ProviderCatalogEntry[];
  initial: FormState;
  busy: boolean;
  error: string;
  onSubmit: (values: ProviderKeyInput) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<FormState>(initial);
  const entry = catalog.find((candidate) => candidate.id === values.provider);
  const set = (patch: Partial<FormState>) => setValues((prev) => ({ ...prev, ...patch }));

  function pickProvider(id: ProviderId) {
    const picked = catalog.find((candidate) => candidate.id === id);
    set({
      provider: id,
      model: picked?.defaultModel ?? "",
      baseUrl: picked?.defaultBaseUrl ?? "",
    });
  }

  function submit() {
    const input: ProviderKeyInput = {
      provider: values.provider,
      label: values.label.trim(),
      model: values.model.trim(),
      baseUrl: values.baseUrl.trim() || undefined,
    };
    if (values.apiKey) input.apiKey = values.apiKey;
    onSubmit(input);
  }

  const keyRequired = entry?.keyRequired ?? false;
  const valid =
    values.label.trim().length > 0 &&
    values.model.trim().length > 0 &&
    (values.provider !== "custom" || values.baseUrl.trim().length > 0);

  return (
    <View style={{ gap: 14 }}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Provider</Text>
      <View style={{ gap: 6 }}>
        {catalog.map((candidate) => {
          const active = candidate.id === values.provider;
          return (
            <Pressable
              key={candidate.id}
              onPress={() => pickProvider(candidate.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 12,
                backgroundColor: active ? "#EAF3FF" : "#F3F4F5",
              }}
            >
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  borderWidth: 2,
                  borderColor: active ? "#1B6DE0" : "#B9BEC4",
                  backgroundColor: active ? "#1B6DE0" : "transparent",
                }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "600", color: colors.text }}>
                  {candidate.displayName}
                </Text>
                {!candidate.agentChatSupported && (
                  <Text style={s.small}>Stored only — agent chat not supported by the SDK</Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
      {entry?.agentChatNote && (
        <Text style={[s.small, { color: colors.muted }]}>{entry.agentChatNote}</Text>
      )}
      <Field label="Label" value={values.label} onChangeText={(label) => set({ label })} />
      <Field label="Model" value={values.model} onChangeText={(model) => set({ model })} />
      <Field
        label={
          values.provider === "custom" ? "Base URL (required)" : "Base URL (optional override)"
        }
        value={values.baseUrl}
        onChangeText={(baseUrl) => set({ baseUrl })}
        autoCapitalize="none"
        placeholder={entry?.defaultBaseUrl ?? "https://…"}
      />
      <Field
        label={keyRequired ? "API key (required)" : "API key (optional for this provider)"}
        value={values.apiKey}
        onChangeText={(apiKey) => set({ apiKey })}
        secureTextEntry
        autoCapitalize="none"
        placeholder="Write-only — never shown again"
      />
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8 }]}>
        <Button onPress={onClose}>Cancel</Button>
        <Button primary busy={busy} disabled={!valid || busy} onPress={submit}>
          Save
        </Button>
      </View>
    </View>
  );
}

export function ModelSettingsScreen({ api }: { api: MuseApi }) {
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [items, setItems] = useState<ProviderKeyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addProvider, setAddProvider] = useState<ProviderId | null>(null);
  const [editing, setEditing] = useState<ProviderKeyMeta | null>(null);
  const [deleting, setDeleting] = useState<ProviderKeyMeta | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [selecting, setSelecting] = useState<string | null>(null);
  const [tests, setTests] = useState<
    Record<string, { busy: boolean; result?: ProviderTest; error?: string }>
  >({});

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [entries, providers] = await Promise.all([listProviders(api), loadCatalog(api)]);
      setItems(entries);
      setCatalog(providers);
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(input: ProviderKeyInput) {
    setFormBusy(true);
    setFormError("");
    try {
      const created = await createProvider(api, input);
      setItems((prev) => [...prev, created]);
      setShowAdd(false);
    } catch (e) {
      setFormError(requestMessage(e));
    } finally {
      setFormBusy(false);
    }
  }

  async function handleUpdate(id: string, input: ProviderKeyInput) {
    setFormBusy(true);
    setFormError("");
    try {
      const patch: Partial<ProviderKeyInput> = {
        label: input.label,
        model: input.model,
        baseUrl: input.baseUrl,
      };
      // Key rotation only when the field is filled in.
      if (input.apiKey) patch.apiKey = input.apiKey;
      const updated = await updateProvider(api, id, patch);
      setItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
      setEditing(null);
    } catch (e) {
      setFormError(requestMessage(e));
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteProvider(api, id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      setDeleting(null);
    } catch (e) {
      setError(requestMessage(e));
    }
  }

  async function handleSelect(id: string) {
    setSelecting(id);
    setError("");
    try {
      const updated = await selectProvider(api, id);
      setItems((prev) =>
        prev.map((item) => (item.id === id ? updated : { ...item, selected: false })),
      );
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setSelecting(null);
    }
  }

  async function runTest(id: string) {
    setTests((prev) => ({ ...prev, [id]: { busy: true } }));
    try {
      const result = await testProvider(api, id);
      setTests((prev) => ({ ...prev, [id]: { busy: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [id]: { busy: false, error: requestMessage(e) } }));
    }
  }

  const localEntry = items.find((item) => item.provider === "local");
  const localCatalog = catalog.find((candidate) => candidate.id === "local");

  function openAdd(provider?: ProviderId) {
    setAddProvider(provider ?? null);
    setShowAdd(true);
  }

  function blankForm(): FormState {
    const first = (addProvider && catalog.find((c) => c.id === addProvider)) || catalog[0];
    return {
      provider: first?.id ?? "deepseek",
      label: "",
      model: first?.defaultModel ?? "",
      baseUrl: first?.defaultBaseUrl ?? "",
      apiKey: "",
    };
  }

  function editForm(item: ProviderKeyMeta): FormState {
    return {
      provider: item.provider,
      label: item.label,
      model: item.model,
      baseUrl: item.baseUrl ?? "",
      apiKey: "",
    };
  }

  return (
    <View style={{ gap: 22 }}>
      <Card>
        <SectionHeading title="Models & API keys" />
        <ErrorNotice error={error} />
        {loading ? (
          <Text style={s.muted}>Loading…</Text>
        ) : (
          <>
            {localCatalog && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  padding: 12,
                  borderRadius: 12,
                  backgroundColor: "#F3F4F5",
                  marginBottom: 12,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "600", color: colors.text }}>
                    Local model (Ollama)
                  </Text>
                  <Text style={s.small}>
                    {localEntry
                      ? `${localEntry.label} · ${localEntry.model}`
                      : "Not added — Ollama runs free on this box, no API key needed."}
                  </Text>
                </View>
                {!localEntry && (
                  <Button small onPress={() => openAdd("local")}>
                    Add
                  </Button>
                )}
              </View>
            )}
            {items.length === 0 ? (
              <Empty
                icon={KeyRound}
                title="No provider keys yet"
                detail="Add a key to switch the agent between models without touching .env."
              />
            ) : (
              <View style={{ gap: 8 }}>
                {items.map((item) => {
                  const entry = catalog.find((candidate) => candidate.id === item.provider);
                  const test = tests[item.id];
                  return (
                    <View
                      key={item.id}
                      style={{
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: "#F3F4F5",
                        gap: 8,
                      }}
                    >
                      <View style={[s.row, { gap: 10, alignItems: "center" }]}>
                        <Pressable
                          onPress={() => handleSelect(item.id)}
                          accessibilityLabel={`Select ${item.label}`}
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            borderWidth: 2,
                            borderColor: item.selected ? "#1B6DE0" : "#B9BEC4",
                            backgroundColor: item.selected ? "#1B6DE0" : "transparent",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {item.selected && <Check size={12} color="#fff" />}
                        </Pressable>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontWeight: "600", color: colors.text }}>
                            {item.label}
                          </Text>
                          <Text style={s.small}>
                            {item.model} · key {item.keyHint}
                          </Text>
                          <ProviderName entry={entry} />
                        </View>
                        {item.selected && (
                          <Text style={[s.small, { color: "#1B6DE0", fontWeight: "600" }]}>
                            Active
                          </Text>
                        )}
                      </View>
                      {selecting === item.id && <Text style={s.muted}>Switching model…</Text>}
                      {test?.result && (
                        <View style={[s.row, { gap: 6, alignItems: "center" }]}>
                          {test.result.ok ? (
                            <>
                              <ShieldCheck size={14} color="#1F9D55" />
                              <Text style={[s.small, { color: "#1F9D55" }]}>Key works</Text>
                            </>
                          ) : (
                            <>
                              <AlertTriangle size={14} color="#C2410C" />
                              <Text style={[s.small, { color: "#C2410C", flex: 1 }]}>
                                {test.result.detail ?? "Test failed"}
                              </Text>
                            </>
                          )}
                        </View>
                      )}
                      {test?.error && (
                        <Text style={[s.small, { color: "#C2410C" }]}>{test.error}</Text>
                      )}
                      <View style={[s.row, { gap: 8 }]}>
                        <Button
                          small
                          icon={RefreshCw}
                          busy={test?.busy}
                          onPress={() => runTest(item.id)}
                        >
                          Test
                        </Button>
                        <Button small icon={Pencil} onPress={() => setEditing(item)}>
                          Edit
                        </Button>
                        <Button small icon={Trash2} danger onPress={() => setDeleting(item)}>
                          Remove
                        </Button>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
            <View style={{ marginTop: 12 }}>
              <Button icon={Plus} primary onPress={() => openAdd()}>
                Add provider key
              </Button>
            </View>
          </>
        )}
      </Card>

      {showAdd && (
        <Sheet title="Add provider key" onClose={() => setShowAdd(false)}>
          <ProviderForm
            catalog={catalog}
            initial={blankForm()}
            busy={formBusy}
            error={formError}
            onSubmit={handleCreate}
            onClose={() => setShowAdd(false)}
          />
        </Sheet>
      )}

      {editing && (
        <Sheet title={`Edit ${editing.label}`} onClose={() => setEditing(null)}>
          <ProviderForm
            catalog={catalog.filter((candidate) => candidate.id === editing.provider)}
            initial={editForm(editing)}
            busy={formBusy}
            error={formError}
            onSubmit={(input) => handleUpdate(editing.id, input)}
            onClose={() => setEditing(null)}
          />
        </Sheet>
      )}

      {deleting && (
        <Sheet title="Remove provider key" onClose={() => setDeleting(null)}>
          <Text style={{ color: colors.text }}>
            Remove “{deleting.label}” ({deleting.model})?{" "}
            {deleting.selected
              ? "It is the active provider — the agent falls back to the .env configuration."
              : "This cannot be undone."}
          </Text>
          <View style={[s.row, { gap: 8, marginTop: 14 }]}>
            <Button onPress={() => setDeleting(null)} icon={X}>
              Cancel
            </Button>
            <Button danger onPress={() => handleDelete(deleting.id)} icon={Trash2}>
              Remove
            </Button>
          </View>
        </Sheet>
      )}
    </View>
  );
}
