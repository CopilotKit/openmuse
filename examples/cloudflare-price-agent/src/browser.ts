import puppeteer from "@cloudflare/puppeteer";
import { DemoError, publicUrl, record, text } from "./core";

type BrowserConnection = Awaited<ReturnType<typeof puppeteer.launch>>;
type BrowserPage = Awaited<ReturnType<BrowserConnection["newPage"]>>;

function expired(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:404|410|session.*(?:expired|closed|not found)|browser.*not found)/i.test(error.message)
  );
}

export interface BrowserStatus {
  sessionId: string;
  conversationId: string;
  url: string;
  title: string;
  startedAt: number;
}

export interface Observation {
  url: string;
  title: string;
  text: string;
  observedAt: string;
  elements: { ref: number; tag: string; label: string; href: string | null }[];
  restarted: boolean;
}

export class DemoBrowser {
  private connection: BrowserConnection | null = null;
  private page: BrowserPage | null = null;
  private restartNotice = false;

  constructor(
    private readonly binding: Env["BROWSER"],
    private readonly status: () => BrowserStatus | null,
    private readonly update: (status: BrowserStatus | null) => void,
    private readonly screenshot: (image: string) => void,
    private readonly onCreated: (sessionId: string) => Promise<void>,
  ) {}

  async ensure(conversationId: string): Promise<BrowserPage> {
    let saved = this.status();
    if (saved && saved.conversationId !== conversationId) {
      await this.close();
      saved = null;
    }
    if (this.connection?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    if (saved) {
      try {
        this.connection = await puppeteer.connect(this.binding, saved.sessionId);
      } catch (error) {
        if (!expired(error))
          throw new DemoError("无法重新连接云端浏览器，请稍后重试", 502, "browser_unavailable");
        this.connection = null;
        this.update(null);
        this.restartNotice = true;
      }
    }
    if (!this.connection?.isConnected()) {
      this.connection = await puppeteer.launch(this.binding, { keep_alive: 120_000 });
      const sessionId = this.connection.sessionId();
      if (!sessionId) {
        await this.connection.close();
        throw new DemoError("Cloudflare 未返回浏览器会话 ID", 502, "browser_unavailable");
      }
      this.update({
        sessionId,
        conversationId,
        url: "about:blank",
        title: "新浏览器",
        startedAt: Date.now(),
      });
      await this.onCreated(sessionId);
    }
    const pages = await this.connection.pages();
    this.page = pages.find((page) => !page.isClosed()) ?? (await this.connection.newPage());
    await this.page.setViewport({ width: 1280, height: 800 });
    await this.page.setRequestInterception(true);
    this.page.removeAllListeners("request");
    this.page.on("request", (request) => {
      try {
        const url = request.url();
        if (/^https?:/i.test(url)) publicUrl(url);
        void request.continue().catch(() => {});
      } catch {
        void request.abort("blockedbyclient").catch(() => {});
      }
    });
    this.page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    return this.page;
  }

  private async inspect(page: BrowserPage): Promise<Observation> {
    const url = page.url();
    if (url !== "about:blank") publicUrl(url);
    const snapshot = await page.evaluate(() => {
      const visible = (node: Element) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      for (const element of document.querySelectorAll("[data-openmuse-ref]")) {
        element.removeAttribute("data-openmuse-ref");
      }
      const elements = [
        ...document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link]"),
      ]
        .filter(visible)
        .slice(0, 100)
        .map((node, ref) => {
          node.setAttribute("data-openmuse-ref", String(ref));
          return {
            ref,
            tag: node.tagName.toLowerCase(),
            label: (
              node.getAttribute("aria-label") ||
              node.getAttribute("placeholder") ||
              node.textContent ||
              node.getAttribute("name") ||
              ""
            )
              .trim()
              .slice(0, 180),
            href: node instanceof HTMLAnchorElement && node.href.length <= 1000 ? node.href : null,
          };
        });
      return {
        title: document.title.slice(0, 200),
        text: document.body?.innerText.slice(0, 12_000) ?? "",
        elements,
      };
    });
    const saved = this.status();
    if (saved) this.update({ ...saved, url, title: snapshot.title });
    try {
      const image = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64" });
      this.screenshot(image);
    } catch {
      // A failed image must not turn a successful page read into a fabricated failure.
      this.screenshot("");
    }
    const restarted = this.restartNotice;
    this.restartNotice = false;
    return { ...snapshot, url, observedAt: new Date().toISOString(), restarted };
  }

  async read(conversationId: string): Promise<Observation> {
    return this.inspect(await this.ensure(conversationId));
  }

  async action(conversationId: string, name: string, input: unknown): Promise<Observation> {
    const args = record(input);
    const page = await this.ensure(conversationId);
    if (name === "browser_search" || name === "browser_navigate") {
      const url =
        name === "browser_search"
          ? `https://www.bing.com/search?q=${encodeURIComponent(text(args.query, "搜索词", 1000))}`
          : publicUrl(args.url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    } else if (name === "browser_read") {
      // Reading also refreshes element references after manual interaction.
    } else if (name === "browser_click" || name === "browser_type") {
      if (!Number.isInteger(args.ref) || Number(args.ref) < 0 || Number(args.ref) > 99) {
        throw new DemoError("需要最近页面中有效的元素 ref");
      }
      const selector = `[data-openmuse-ref="${args.ref}"]`;
      const element = await page.$(selector);
      if (!element) throw new DemoError("页面已变化，请先重新读取页面");
      try {
        const info = await element.evaluate((node) => ({
          label: (node.textContent || node.getAttribute("aria-label") || "").trim(),
          type: node.getAttribute("type"),
          tag: node.tagName.toLowerCase(),
        }));
        if (name === "browser_type") {
          if (
            !["input", "textarea"].includes(info.tag) ||
            ["password", "hidden", "file"].includes(info.type ?? "")
          ) {
            throw new DemoError("此元素不是可填写的普通输入框");
          }
          const value = text(args.text, "输入内容", 1000);
          await element.click({ clickCount: 3 });
          await element.press("Backspace");
          await element.type(value);
        } else {
          if (
            /提交订单|确认支付|立即支付|支付订单|place order|pay now|confirm purchase/i.test(
              info.label,
            )
          ) {
            throw new DemoError("本 demo 只查询价格，不执行订单提交或支付");
          }
          await element.click();
        }
      } finally {
        await element.dispose();
      }
    } else if (name === "browser_key") {
      if (!["Enter", "Tab", "Escape"].includes(String(args.key)))
        throw new DemoError("不支持此按键");
      await page.keyboard.press(args.key as "Enter" | "Tab" | "Escape");
    } else if (name === "browser_scroll") {
      if (!Number.isInteger(args.deltaY) || Math.abs(Number(args.deltaY)) > 4000) {
        throw new DemoError("单次滚动范围为 -4000 到 4000");
      }
      await page.mouse.wheel({ deltaY: Number(args.deltaY) });
    } else {
      throw new DemoError("未知浏览器工具");
    }
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => {});
    return this.inspect(page);
  }

  async liveView(conversationId: string): Promise<string | null> {
    const saved = this.status();
    if (!saved || saved.conversationId !== conversationId) return null;
    const temporary = !this.connection?.isConnected();
    let connection: BrowserConnection | null = null;
    try {
      connection = temporary
        ? await puppeteer.connect(this.binding, saved.sessionId)
        : this.connection;
      const page = (await connection?.pages())?.find((item) => !item.isClosed());
      if (!page) return null;
      const cdp = await page.createCDPSession();
      try {
        const result = await cdp.send("Cloudflare.getLiveView", {
          mode: "tab",
          expiresInMs: 300_000,
        });
        return result.devtoolsFrontendUrl;
      } finally {
        await cdp.detach();
      }
    } catch (error) {
      if (!expired(error))
        throw new DemoError("实时浏览器连接暂不可用", 502, "live_view_unavailable");
      this.connection = null;
      this.page = null;
      this.update(null);
      return null;
    } finally {
      if (temporary) await connection?.disconnect();
    }
  }

  async close(): Promise<void> {
    const saved = this.status();
    try {
      const connection = this.connection?.isConnected()
        ? this.connection
        : saved
          ? await puppeteer.connect(this.binding, saved.sessionId)
          : null;
      await connection?.close();
    } catch (error) {
      if (!expired(error)) {
        throw new DemoError("尚未确认浏览器关闭成功，请重试关闭", 502, "browser_close_failed");
      }
    }
    this.connection = null;
    this.page = null;
    this.update(null);
  }
}
