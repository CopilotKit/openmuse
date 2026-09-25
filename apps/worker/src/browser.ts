import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  capturePdfDownload,
  MAX_DOWNLOAD_BYTES,
  type PdfDownload,
  readDownloadFailures,
} from "./downloads.ts";
import { WorkerError } from "./errors.ts";
import { trustedDomains, validatePublicUrl } from "./network.ts";
import { startEgressProxy } from "./proxy.ts";

// Stealth plugin hides automated-browser fingerprints (navigator.webdriver,
// missing plugins, etc.) so bot protection on news sites lets the worker in.
let stealthChromium: typeof import("playwright-extra").chromium | undefined;
async function getChromium() {
  if (!stealthChromium) {
    const { chromium } = await import("playwright-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    chromium.use(StealthPlugin());
    stealthChromium = chromium;
  }
  return stealthChromium;
}

// Cloudflare challenge handling, ported from Scrapling's _cloudflare_solver:
// wait out non-interactive ("Verifying you are human") pages, and click the
// Turnstile checkbox at randomized coordinates for interactive ones.
const CF_CHALLENGE_PATTERN =
  /^https?:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\//;
const CF_MAX_SOLVE_ATTEMPTS = 3;

function detectCloudflareChallenge(
  html: string,
  title: string,
): "non-interactive" | "interactive" | null {
  if (/challenges\.cloudflare\.com/i.test(html)) {
    return /cf-turnstile|cf_turnstile|class="[^"]*turnstile/i.test(html)
      ? "interactive"
      : "non-interactive";
  }
  return /just a moment|verifying you are human/i.test(html) || /just a moment/i.test(title)
    ? "non-interactive"
    : null;
}

async function challengeCleared(page: Page): Promise<boolean> {
  const html = await page.content().catch(() => "");
  return detectCloudflareChallenge(html, "") === null;
}

async function solveCloudflare(page: Page, attempts = 0): Promise<void> {
  if (attempts >= CF_MAX_SOLVE_ATTEMPTS) return;
  const html = await page.content().catch(() => "");
  const title = await page.title().catch(() => "");
  const challenge = detectCloudflareChallenge(html, title);
  if (!challenge) return;
  if (challenge === "non-interactive") {
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      if (await challengeCleared(page)) return;
    }
    return;
  }
  // Interactive Turnstile: locate the challenge iframe and click the checkbox.
  for (let i = 0; i < 20; i++) {
    const frame = page.frames().find((f) => CF_CHALLENGE_PATTERN.test(f.url()));
    const frameEl = frame ? await frame.frameElement().catch(() => null) : null;
    const box = frameEl ? await frameEl.boundingBox().catch(() => null) : null;
    if (box) {
      const x = box.x + 26 + Math.random() * 2;
      const y = box.y + 25 + Math.random() * 2;
      await page.mouse.click(x, y, { delay: 100 + Math.random() * 100 });
      break;
    }
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(100);
    if (await challengeCleared(page)) return;
  }
  return solveCloudflare(page, attempts + 1);
}

export interface Session {
  id: string;
  title: string;
  url: string;
  status: "active" | "closed" | "error";
  updatedAt: string;
  /** Updated whenever the session is used; used for idle eviction. */
  lastUsedAt?: string;
  /** Set when the last navigation was preempted by a file download. */
  download?: PdfDownload | null;
}
type Running = {
  context: BrowserContext;
  page: Page;
  touched: number;
  pending: Set<Promise<void>>;
  downloadError?: boolean;
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The hostname of a URL, or "" when it cannot be parsed. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when the page hostname is exactly the expected login domain or a
 * subdomain of it. Lookalike domains (evil-example.com) never match.
 */
function domainMatches(hostname: string, expected: string): boolean {
  const actual = hostname.toLowerCase();
  const wanted = expected.toLowerCase();
  return actual === wanted || actual.endsWith(`.${wanted}`);
}

export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new WorkerError("INVALID_SESSION", "A valid UUID session ID is required.");
  return id.toLowerCase();
}

export async function createBrowserManager(options: {
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
}) {
  const { dataDir, maxSessions = 3, idleTimeoutMs = 30 * 60_000 } = options;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const proxy = await startEgressProxy();
  for (const id of await readdir(dataDir)) {
    if (!SESSION_ID.test(id)) continue;
    try {
      const stored = JSON.parse(
        await readFile(join(dataDir, id, "session.json"), "utf8"),
      ) as Session;
      sessions.set(id, {
        ...stored,
        id,
        status: "closed",
        lastUsedAt: stored.lastUsedAt ?? stored.updatedAt,
      });
    } catch {
      /* An incomplete first launch has no session metadata to restore. */
    }
    if (sessions.has(id)) await readDownloadFailures(join(dataDir, id), true);
  }
  const directory = (id: string) => join(dataDir, validateSessionId(id));
  // Auto-evict closed sessions that haven't been used in 7 days to prevent profile accumulation.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  for (const [id, session] of [...sessions.entries()]) {
    if (session.status === "closed") {
      const lastUsed = session.lastUsedAt ? new Date(session.lastUsedAt).getTime() : 0;
      if (Date.now() - lastUsed > SEVEN_DAYS_MS) {
        sessions.delete(id);
        try {
          await rm(join(dataDir, id), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  async function persist(session: Session) {
    const path = join(directory(session.id), "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function active(id: string) {
    const value = running.get(id);
    if (!value || value.page.isClosed())
      throw new WorkerError(
        "SESSION_CLOSED",
        "Open this browser session before using its console.",
        409,
      );
    value.touched = Date.now();
    return value;
  }
  async function refresh(id: string) {
    const instance = active(id);
    if (instance.page.url() !== "about:blank") await validatePublicUrl(instance.page.url());
    const session: Session = {
      id,
      title: (await instance.page.title()).slice(0, 300),
      url: instance.page.url(),
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    await persist(session);
    return session;
  }
  async function downloads(id: string): Promise<PdfDownload[]> {
    if (!sessions.has(id))
      throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    const folder = join(directory(id), "downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const list: PdfDownload[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(await readFile(join(folder, name), "utf8")) as PdfDownload;
      list.push(item);
    }
    return list;
  }
  async function navigate(id: string, url: string) {
    const target = await validatePublicUrl(url);
    const instance = active(id);
    const { page } = instance;
    // Downloads are captured asynchronously; snapshot the known ids so a
    // download that preempts this navigation can be identified below.
    const knownDownloads = new Set((await downloads(id)).map((d) => d.id));
    try {
      await page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      // Scrapling-style: clear Cloudflare Turnstile / "Verifying you are human"
      // challenges before reporting the page.
      await solveCloudflare(page);
      // Chromium can follow redirects outside Playwright's initial route hook.
      // The proxy blocks those sockets, but its 403 is still an HTTP response:
      // validate the final location so the API does not report it as success.
      await validatePublicUrl(page.url());
    } catch (error) {
      if (error instanceof WorkerError && error.code === "BLOCKED_URL") {
        await page.goto("about:blank", { timeout: 5000 });
      }
      // A download aborts page.goto: the requested URL never loaded, so the
      // previous page must not be left up as if it were the current one
      // (it would be reported as the navigation result). Park on
      // about:blank and report the download that preempted the navigation.
      if (error instanceof Error && /Download is starting/.test(error.message)) {
        await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
        await Promise.allSettled([...instance.pending]);
        const fresh = (await downloads(id)).filter((d) => !knownDownloads.has(d.id));
        return { ...(await refresh(id)), download: fresh[0] ?? null };
      }
      // A successful attachment intentionally aborts page navigation.
      throw new WorkerError(
        "NAVIGATION_FAILED",
        "The page could not be loaded. It may be unreachable or contain a blocked destination.",
        502,
      );
    }
    return refresh(id);
  }
  async function closeSession(id: string) {
    const instance = running.get(id);
    const stored = sessions.get(id);
    if (!stored) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    if (instance) {
      await instance.context.storageState({ path: join(directory(id), "storage.json") });
      await instance.context.close();
      await Promise.allSettled(instance.pending);
      running.delete(id);
    }
    const result: Session = { ...stored, status: "closed", updatedAt: new Date().toISOString() };
    sessions.set(id, result);
    await persist(result);
    return result;
  }
  async function createSession(id: string, url: string) {
    await validatePublicUrl(url);
    if (running.has(id)) return navigate(id, url);
    if (running.size >= maxSessions) {
      // A personal agent must never dead-end at the cap: evict the
      // least-recently-used running session instead of refusing the new one.
      // Touches come from navigation, input, reads and screenshots, so the
      // session the owner is actively viewing is never the victim. The hard
      // cap on concurrent sessions is unchanged.
      let oldest: string | undefined;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [other, instance] of running)
        if (instance.touched < oldestTouched) {
          oldest = other;
          oldestTouched = instance.touched;
        }
      if (!oldest)
        throw new WorkerError(
          "SESSION_LIMIT",
          `Close an active session before opening another (limit ${maxSessions}).`,
          409,
        );
      await closeSession(oldest);
    }
    if (!sessions.has(id) && sessions.size >= 200)
      throw new WorkerError(
        "PROFILE_LIMIT",
        "The worker has reached its 200 saved-profile limit.",
        409,
      );
    const previous = sessions.get(id);
    const profileDir = join(directory(id), "profile");
    const tempDirectory = join("/tmp", `openmuse-downloads-${id}`);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      const chromium = await getChromium();
      // Trusted self-hosted domains (BROWSER_TRUSTED_DOMAINS) resolve via the
      // worker's own DNS (/etc/hosts) to the owner's LAN origin. They must
      // bypass the egress proxy: the proxy resolves them publicly, which
      // hits CloudFront instead of the origin (403s) and defeats the
      // split-horizon setup. Chromium honors /etc/hosts only when it dials
      // directly, so list the trusted domains (apex + wildcard for
      // subdomains, matching isTrustedDomain) in the proxy bypass.
      const proxyBypass = ["<-loopback>", ...trustedDomains().flatMap((d) => [d, `*.${d}`])].join(
        ",",
      );
      // Chromium's own DNS is locked down to loopback (everything else must go
      // through the egress proxy), so the proxy-bypassed trusted domains
      // above need matching resolver excludes or their direct connections
      // would fail with ~NOTFOUND.
      const resolverExcludes = ["127.0.0.1", ...trustedDomains().flatMap((d) => [d, `*.${d}`])];
      const hostResolverRules = [
        "MAP * ~NOTFOUND",
        ...resolverExcludes.map((host) => `EXCLUDE ${host}`),
      ].join(", ");
      context = await chromium.launchPersistentContext(profileDir, {
        // Chromium does not need the worker API credential in its environment.
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
        headless: true,
        viewport: { width: 1280, height: 800 },
        // The owner's Cloudflare-fronted sites serve self-signed origin
        // certificates (normal with Cloudflare in front); the worker talks to
        // them over the owner's own LAN. Destination SSRF validation still
        // applies to every request.
        ignoreHTTPSErrors: true,
        proxy: { server: proxy.url, bypass: proxyBypass },
        serviceWorkers: "block",
        acceptDownloads: true,
        downloadsPath: tempDirectory,
        timeout: 25_000,
        args: [
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-extensions",
          `--host-resolver-rules=${hostResolverRules}`,
        ],
      });
    } catch {
      if (!previous) await rm(directory(id), { recursive: true, force: true });
      await rm(tempDirectory, { recursive: true, force: true });
      throw new WorkerError(
        "BROWSER_UNAVAILABLE",
        "Chromium could not start. Rebuild the browser-worker image and check its resource limits.",
        503,
      );
    }
    try {
      const statePath = join(directory(id), "storage.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as Awaited<
          ReturnType<BrowserContext["storageState"]>
        >;
        await context.addCookies(state.cookies);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await context.route("**/*", async (route) => {
        try {
          await validatePublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      for (const old of context.pages()) await old.close();
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const instance: Running = { context, page, touched: Date.now(), pending: new Set() };
      running.set(id, instance);
      context.on("page", (popup) => {
        void popup.close();
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      page.on("download", (download) => {
        const pending = downloads(id).then((saved) =>
          capturePdfDownload({
            directory: directory(id),
            tempDirectory,
            download,
            limitReached: saved.length + instance.pending.size > 20,
          }),
        );
        instance.pending.add(pending);
        void pending.then(
          () => instance.pending.delete(pending),
          () => {
            instance.downloadError = true;
            instance.pending.delete(pending);
          },
        );
      });
      const initial: Session = {
        id,
        title: previous?.title ?? "New session",
        url,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      sessions.set(id, initial);
      await persist(initial);
      return await navigate(id, url);
    } catch (error) {
      await context.close().catch(() => {});
      await Promise.allSettled(running.get(id)?.pending ?? []);
      running.delete(id);
      if (previous) {
        const failed: Session = {
          ...previous,
          url,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, failed);
        await persist(failed);
      } else {
        sessions.delete(id);
        await rm(directory(id), { recursive: true, force: true });
      }
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const sweeper = setInterval(() => {
    for (const [id, instance] of running)
      if (Date.now() - instance.touched > idleTimeoutMs) {
        void serial(id, () => closeSession(id)).catch(() => {});
      }
  }, 60_000);
  sweeper.unref();
  return {
    list: () => [...sessions.values()],
    create: (id: string, url: string) =>
      serial("create", () => serial(id, () => createSession(id, url))),
    navigate: (id: string, url: string) => serial(id, () => navigate(id, url)),
    closeSession: (id: string) => serial(id, () => closeSession(id)),
    screenshot: (id: string) =>
      serial(id, () => active(id).page.screenshot({ type: "png", timeout: 10_000 })),
    read: (id: string) =>
      serial(id, async () => {
        const { page } = active(id);
        // A download-preempted navigation parks the page on about:blank;
        // there is no destination to validate (mirrors refresh()).
        if (page.url() !== "about:blank") await validatePublicUrl(page.url());
        // Evaluation is fixed by the worker; callers cannot inject JavaScript.
        const result = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          return {
            url: location.href,
            title: document.title.slice(0, 300),
            text: text.slice(0, 100_000),
            truncated: text.length > 100_000,
          };
        });
        if (result.url !== "about:blank") await validatePublicUrl(result.url);
        const session: Session = {
          id,
          url: result.url,
          title: result.title,
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, session);
        await persist(session);
        return result;
      }),
    snapshot: (id: string) =>
      serial(id, async () => {
        const { page } = active(id);
        if (page.url() !== "about:blank") await validatePublicUrl(page.url());
        // Evaluation is fixed by the worker; callers cannot inject JavaScript.
        const elements = await page.evaluate(() => {
          const labelFor = (el: Element): string => {
            const htmlEl = el as HTMLElement;
            const input = el as HTMLInputElement;
            const direct =
              htmlEl.innerText ||
              input.placeholder ||
              input.value ||
              el.getAttribute("aria-label") ||
              "";
            if (direct.trim()) return direct;
            const idAttr = el.getAttribute("id");
            if (idAttr) {
              const label = document.querySelector(`label[for="${CSS.escape(idAttr)}"]`);
              const text = label?.textContent?.trim();
              if (text) return text;
            }
            return el.getAttribute("name") || "";
          };
          const out: Array<{ tag: string; type: string; label: string; x: number; y: number }> = [];
          const nodes = document.querySelectorAll(
            "a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=textbox]",
          );
          for (const el of Array.from(nodes).slice(0, 200)) {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) continue;
            out.push({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || el.getAttribute("role") || "",
              label: labelFor(el).trim().replace(/\s+/g, " ").slice(0, 80),
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            });
          }
          return out;
        });
        return {
          url: page.url(),
          title: (await page.title()).slice(0, 300),
          elements,
        };
      }),
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        const { page } = active(id);
        const { type, x, y, key, text, deltaY, option } = input;
        if (
          type === "click" &&
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          x < 1280 &&
          y >= 0 &&
          y < 800
        )
          await page.mouse.click(x, y);
        else if (type === "text" && typeof text === "string" && text.length <= 10_000)
          await page.keyboard.insertText(text);
        else if (
          type === "key" &&
          typeof key === "string" &&
          /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/.test(
            key,
          )
        )
          await page.keyboard.press(key);
        else if (
          type === "scroll" &&
          typeof deltaY === "number" &&
          Number.isFinite(deltaY) &&
          Math.abs(deltaY) <= 5000
        )
          await page.mouse.wheel(0, deltaY);
        else if (
          type === "select" &&
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          x < 1280 &&
          y >= 0 &&
          y < 800 &&
          typeof option === "string" &&
          option.length > 0 &&
          option.length <= 500
        ) {
          // Native <select> dropdowns only. The evaluation is fixed by the
          // worker: find the select under the point, tag it, then drive it
          // with Playwright's selectOption (matches label first, then value).
          const marker = await page.evaluate(
            ({ px, py }: { px: number; py: number }) => {
              const el = document.elementFromPoint(px, py);
              const select = el?.closest ? el.closest("select") : null;
              if (!select || (select as HTMLSelectElement).disabled) return null;
              const token = `om-${Math.random().toString(36).slice(2)}`;
              select.setAttribute("data-om-select", token);
              return token;
            },
            { px: x, py: y },
          );
          if (!marker)
            throw new WorkerError("INVALID_INPUT", "No dropdown found at those coordinates.");
          try {
            const locator = page.locator(`select[data-om-select="${marker}"]`);
            const picked = await locator.selectOption({ label: option });
            if (picked.length === 0) await locator.selectOption(option);
          } finally {
            await page.evaluate((token: string) => {
              document
                .querySelector(`select[data-om-select="${CSS.escape(token)}"]`)
                ?.removeAttribute("data-om-select");
            }, marker);
          }
        } else throw new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
        return refresh(id);
      }),
    fill: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        const { page } = active(id);
        const { username, password, expectedDomain } = input;
        if (
          typeof username !== "string" ||
          typeof password !== "string" ||
          username.length === 0 ||
          username.length > 1024 ||
          password.length === 0 ||
          password.length > 4096
        )
          throw new WorkerError("INVALID_FILL", "A username and password are required.");
        if (typeof expectedDomain !== "string" || expectedDomain.length === 0)
          throw new WorkerError("INVALID_FILL", "The expected login domain is required.");
        // Independent domain check: the worker refuses to type credentials
        // into any page whose hostname is not the expected domain (or a
        // subdomain of it), even if the caller already checked.
        const hostname = safeHostname(page.url());
        if (!domainMatches(hostname, expectedDomain))
          throw new WorkerError(
            "DOMAIN_MISMATCH",
            `The current page is not on ${expectedDomain}; credentials were not filled.`,
            403,
          );
        // Locate the login form heuristically: the first visible password field
        // plus a username/email-shaped text field. Nothing is typed unless a
        // password field exists, so this can never fill a search box.
        const fields = await page.evaluateHandle(() => {
          const visible = (element: Element) => {
            const rect = (element as HTMLElement).getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(element).visibility !== "hidden" &&
              !(element as HTMLInputElement).disabled
            );
          };
          const inputs = Array.from(document.querySelectorAll("input")).filter(
            (element) => visible(element) && (element as HTMLInputElement).type !== "hidden",
          ) as HTMLInputElement[];
          const passwordField = inputs.find((element) => element.type === "password") ?? null;
          const usernameField =
            inputs.find((element) => {
              if (element === passwordField) return false;
              if (element.type === "email") return true;
              if (element.type !== "text" && element.type !== "tel") return false;
              const haystack =
                `${element.name} ${element.id} ${element.placeholder} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
              return /user|email|login|account/.test(haystack);
            }) ??
            inputs.find(
              (element) =>
                element !== passwordField && (element.type === "text" || element.type === "email"),
            ) ??
            null;
          return { usernameField, passwordField };
        });
        const usernameElement = (await fields.getProperty("usernameField")).asElement();
        const passwordElement = (await fields.getProperty("passwordField")).asElement();
        await fields.dispose();
        if (!passwordElement)
          throw new WorkerError(
            "LOGIN_FIELDS_NOT_FOUND",
            "No password field was found on this page. Open the site's login form first.",
          );
        if (usernameElement) await usernameElement.fill(username);
        await passwordElement.fill(password);
        // Most login forms submit on Enter; fall back to leaving the filled
        // form in place if nothing navigates.
        await passwordElement.press("Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
        return { ...(await refresh(id)), filled: true, submitted: true };
      }),
    downloads: async (id: string) => {
      const saved = await downloads(id);
      if (running.get(id)?.downloadError)
        throw new WorkerError(
          "DOWNLOAD_STORE_FAILED",
          "A download outcome could not be saved. Check worker storage and try again.",
          500,
        );
      return { downloads: saved, failures: await readDownloadFailures(directory(id)) };
    },
    download: async (id: string, downloadId: string) => {
      validateSessionId(downloadId);
      const metadata = (await downloads(id)).find((item) => item.id === downloadId);
      if (!metadata) throw new WorkerError("DOWNLOAD_NOT_FOUND", "PDF download not found.", 404);
      const path = join(directory(id), "downloads", `${downloadId}.pdf`);
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES)
        throw new WorkerError("DOWNLOAD_TOO_LARGE", "The PDF exceeds 10 MiB.", 413);
      return { metadata, bytes: await readFile(path) };
    },
    close: async () => {
      clearInterval(sweeper);
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...running.keys()].map(closeSession));
      await proxy.close();
    },
  };
}
