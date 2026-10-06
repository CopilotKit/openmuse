import { z } from "zod";
export const uuidSchema = z.string().uuid();
export const versionSchema = z
  .string()
  .max(32)
  .regex(/^\d+(?:\.\d+){1,3}$/);
export const platformSchema = z.enum(["web", "ios", "android"]);
const stepSchema = z.enum(["welcome", "connect", "workspace", "first_answer"]);
const errorSchema = z.enum([
  "network",
  "unauthorized",
  "rate_limited",
  "server",
  "invalid_response",
  "cancelled",
  "unknown",
]);
export type SetupStep = z.infer<typeof stepSchema>;
export type ErrorClass = z.infer<typeof errorSchema>;
const eventSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("oss.onboarding.step_viewed"),
      properties: z.object({ step: stepSchema }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("oss.onboarding.setup_failed"),
      properties: z.object({ step: stepSchema, error_class: errorSchema }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("oss.onboarding.setup_abandoned"),
      properties: z.object({ step: stepSchema }).strict(),
    })
    .strict(),
  z
    .object({ event: z.literal("oss.onboarding.activated"), properties: z.object({}).strict() })
    .strict(),
]);
const metadataSchema = z
  .object({
    accessibility_title: z.literal("OpenMuse"),
    platform: platformSchema,
    app_version: versionSchema,
  })
  .strict();
const wireSchema = z
  .object({
    event: z.string(),
    properties: z.unknown(),
    event_id: uuidSchema,
    ts: z.number().int().nonnegative(),
    global_properties: metadataSchema,
    package: z.object({ name: z.literal("openmuse-client"), version: versionSchema }).strict(),
  })
  .strict()
  .superRefine((v, c) => {
    if (!eventSchema.safeParse({ event: v.event, properties: v.properties }).success)
      c.addIssue({ code: "custom", message: "Invalid event" });
  });
export type Envelope = z.infer<typeof eventSchema> & {
  event_id: string;
  ts: number;
  global_properties: z.infer<typeof metadataSchema>;
  package: { name: "openmuse-client"; version: string };
};
const retrySchema = {
  attempts: z.number().int().min(0).max(10),
  next: z.number().nonnegative(),
  created: z.number().nonnegative(),
};
const linkSchema = z.object({ event_id: uuidSchema, ...retrySchema }).strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    installation_id: uuidSchema,
    queue: z.array(z.object({ envelope: wireSchema, ...retrySchema }).strict()).max(256),
    activated: z.boolean(),
    pending: stepSchema.nullable(),
    viewed: z.array(stepSchema).max(4),
    link: linkSchema.nullable(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
export interface Storage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
interface Options {
  storage: Storage;
  randomUUID: () => string;
  now: () => number;
  send: (id: string, event: Envelope) => Promise<number>;
  disabled: () => boolean;
  platform: z.infer<typeof platformSchema>;
  version: string;
  linkReady?: () => boolean;
  link?: (body: {
    installation_id: string;
    event_id: string;
    platform: z.infer<typeof platformSchema>;
    app_version: string;
  }) => Promise<{ enabled: boolean; linked: boolean }>;
}
const retention = 7 * 86400000;
export function createOnboardingTelemetry(o: Options) {
  let state: State | undefined,
    suspended = false,
    started = false,
    closed = false,
    serial = Promise.resolve(),
    timer: ReturnType<typeof setTimeout> | undefined;
  const safe = (fn: () => Promise<void>) => {
    serial = serial.then(async () => {
      try {
        if (o.disabled()) {
          await purge();
          return;
        }
        if (!suspended && !closed) await fn();
      } catch {
        suspended = true;
        clearTimeout(timer);
      }
    });
    return serial;
  };
  async function purge() {
    suspended = true;
    state = undefined;
    clearTimeout(timer);
    await o.storage.remove();
  }
  const persist = () => o.storage.write(JSON.stringify(state));
  function append(event: z.infer<typeof eventSchema>) {
    if (!state) return;
    state.queue.push({
      envelope: {
        ...event,
        event_id: o.randomUUID(),
        ts: Math.floor(o.now() / 1000),
        global_properties: {
          accessibility_title: "OpenMuse",
          platform: o.platform,
          app_version: o.version,
        },
        package: { name: "openmuse-client", version: o.version },
      },
      attempts: 0,
      next: 0,
      created: o.now(),
    });
    state.queue = state.queue.slice(-256);
  }
  function schedule() {
    clearTimeout(timer);
    if (closed || suspended || !state) return;
    const next = [
      ...state.queue,
      ...(state.link && (o.linkReady?.() ?? true) ? [state.link] : []),
    ].map((x) => x.next);
    if (next.length)
      timer = setTimeout(() => void flush(), Math.max(1000, Math.min(...next) - o.now()));
  }
  async function startInternal() {
    if (started) return;
    started = true;
    versionSchema.parse(o.version);
    const raw = await o.storage.read();
    let parsed: ReturnType<typeof stateSchema.safeParse> | undefined;
    try {
      parsed = stateSchema.safeParse(raw && raw.length < 1024 * 1024 ? JSON.parse(raw) : null);
    } catch {}
    state = parsed?.success
      ? parsed.data
      : {
          version: 1,
          installation_id: uuidSchema.parse(o.randomUUID()),
          queue: [],
          activated: false,
          pending: null,
          viewed: [],
          link: null,
        };
    if (!state.activated && state.pending)
      append({ event: "oss.onboarding.setup_abandoned", properties: { step: state.pending } });
    state.pending = null;
    state.viewed = [];
    await persist();
    schedule();
  }
  const record = (event: z.infer<typeof eventSchema>) =>
    safe(async () => {
      await startInternal();
      append(event);
      await persist();
      schedule();
    });
  let flushing: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      const end = o.now() + 5000;
      for (let count = 0; count < 16 && o.now() < end; count++) {
        let delivery: { id: string; envelope: Envelope } | undefined;
        await safe(async () => {
          await startInternal();
          if (!state) return;
          state.queue = state.queue.filter(
            (x) => o.now() - x.created <= retention && x.attempts < 10,
          );
          const item = state.queue.find((x) => x.next <= o.now());
          if (item) {
            item.attempts++;
            item.next = o.now() + Math.min(60000, 1000 * 2 ** (item.attempts - 1));
            delivery = { id: state.installation_id, envelope: item.envelope as Envelope };
          }
          await persist();
        });
        if (!delivery || suspended || closed || o.disabled()) break;
        const item = delivery;
        let status = 503;
        try {
          status = await o.send(item.id, item.envelope);
        } catch {}
        await safe(async () => {
          if (!state) return;
          if (
            (status >= 200 && status < 300) ||
            (status >= 400 && status < 500 && status !== 408 && status !== 429)
          )
            state.queue = state.queue.filter((x) => x.envelope.event_id !== item.envelope.event_id);
          await persist();
        });
      }
      let link:
        | {
            installation_id: string;
            event_id: string;
            platform: z.infer<typeof platformSchema>;
            app_version: string;
          }
        | undefined;
      await safe(async () => {
        if (!state?.link || !o.link || !(o.linkReady?.() ?? true)) return;
        const item = state.link;
        if (item.attempts >= 10 || o.now() - item.created > retention) state.link = null;
        else if (item.next <= o.now() && o.now() < end) {
          item.attempts++;
          item.next = o.now() + Math.min(60000, 1000 * 2 ** (item.attempts - 1));
          link = {
            installation_id: state.installation_id,
            event_id: item.event_id,
            platform: o.platform,
            app_version: o.version,
          };
        }
        await persist();
      });
      if (link && o.link && !suspended && !closed && !o.disabled()) {
        try {
          const result = await o.link(link);
          if (!result.enabled) await api.disable();
          else
            await safe(async () => {
              if (state) {
                state.link = null;
                await persist();
              }
            });
        } catch {}
      }
      schedule();
    })()
      .catch(() => {
        suspended = true;
        clearTimeout(timer);
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  };
  const api = {
    start: () => safe(startInternal),
    stepViewed: (step: SetupStep) =>
      safe(async () => {
        await startInternal();
        if (!state || state.activated || state.viewed.includes(step)) return;
        state.viewed.push(step);
        state.pending = step;
        append({ event: "oss.onboarding.step_viewed", properties: { step } });
        await persist();
        schedule();
      }),
    setupFailed: (step: SetupStep, error_class: ErrorClass) =>
      record({ event: "oss.onboarding.setup_failed", properties: { step, error_class } }),
    activated: () =>
      safe(async () => {
        await startInternal();
        if (!state || state.activated) return;
        state.activated = true;
        state.pending = null;
        append({ event: "oss.onboarding.activated", properties: {} });
        await persist();
        schedule();
      }),
    linkSession: () =>
      safe(async () => {
        await startInternal();
        if (!state) return;
        state.link ??= { event_id: o.randomUUID(), created: o.now(), attempts: 0, next: 0 };
        await persist();
        schedule();
      }),
    flush,
    disable: () => {
      suspended = true;
      clearTimeout(timer);
      serial = serial.then(purge).catch(() => {});
      return serial;
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
  return api;
}
export function classifyError(error: unknown): ErrorClass {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500) return "server";
  if (error instanceof SyntaxError) return "invalid_response";
  if (error instanceof TypeError) return "network";
  return "unknown";
}
export function hasFreshAnswer(
  before: readonly { id: string; role: string; content?: unknown }[],
  after: readonly { id: string; role: string; content?: unknown }[],
) {
  const prior = new Map(before.filter((x) => x.role === "assistant").map((x) => [x.id, x.content]));
  return after.some(
    (x) =>
      x.role === "assistant" &&
      typeof x.content === "string" &&
      x.content.trim().length > 0 &&
      (!prior.has(x.id) ||
        (typeof prior.get(x.id) === "string" &&
          x.content.startsWith(String(prior.get(x.id))) &&
          x.content.slice(String(prior.get(x.id)).length).trim().length > 0)),
  );
}
