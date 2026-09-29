import { useEffect, useState } from "react";
import type { DeviceModelRouting, ModelRoutingInfo } from "../../../packages/domain/src/agent.ts";
import { useWorkspace } from "./workspace";
/**
 * Fetch the server-wide model routing configuration from /api/agent/models.
 * Returns the info (or null while loading) and the raw error if the fetch fails.
 */
export function useModelRouting() {
  const { api } = useWorkspace();
  const [data, setData] = useState<ModelRoutingInfo | null>();
  const [error, setError] = useState("");
  const refresh = () => {
    setError("");
    setData(undefined);
    void api
      .request<ModelRoutingInfo>("/api/agent/models")
      .then((next) => setData(next))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    refresh();
  }, [api]);
  return { data, error, refresh };
}
/**
 * Fetch available models from /api/agent/available-models.
 * Returns provider availability, default model names, and the server-wide
 * tool allowlist so the mobile UI can validate device overrides.
 */
export function useAvailableModels() {
  const { api } = useWorkspace();
  const [data, setData] = useState<AvailableModels | null>();
  const [error, setError] = useState("");
  const refresh = () => {
    setError("");
    setData(undefined);
    void api
      .request<AvailableModels>("/api/agent/available-models")
      .then((next) => setData(next))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    refresh();
  }, [api]);
  return { data, error, refresh };
}
export interface AvailableModels {
  providers: { openai: boolean; google: boolean };
  models: { chat?: string; task?: string; simpleTask?: string };
  chatToolAllowlist?: string[];
}
/**
 * Fetch and update per-device model routing overrides.
 * These preferences override the server defaults for this specific device,
 * allowing a small mobile model to be selected per task type.
 */
export function useDeviceModelRouting() {
  const { api, refresh: refreshWorkspace } = useWorkspace();
  const [overrides, setOverrides] = useState<DeviceModelRouting>({});
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!api) return;
    setLoaded(false);
    api
      .request<DeviceModelRouting>("/api/agent/device-models")
      .then((next) => {
        setOverrides(next);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, [api]);
  async function save(patch: Partial<DeviceModelRouting>) {
    setError("");
    try {
      await api.request<{ ok: boolean }>("/api/agent/device-models", patch, "PATCH");
      const next = { ...overrides, ...patch };
      setOverrides(next);
      void refreshWorkspace().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return { overrides, error, loaded, save };
}
