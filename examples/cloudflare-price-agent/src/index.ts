import puppeteer from "@cloudflare/puppeteer";
import { getAgentByName } from "agents";
import { type DemoAction, PriceAgent } from "./agent";
import { authorized, DemoError, escapeHtml, readJson, record, text, uuid } from "./core";

export { PriceAgent };

const fixtureProducts = [
  { id: "headphones-a", name: "演示耳机 A", price: "¥9,800", category: "耳机" },
  { id: "headphones-b", name: "演示耳机 B", price: "¥12,800", category: "耳机" },
  { id: "headphones-c", name: "演示耳机 C", price: "¥6,500", category: "耳机" },
  { id: "keyboard-a", name: "演示键盘 A", price: "¥7,200", category: "键盘" },
];

function checkpointTestPage(url: URL, request: Request): Response {
  const seed = url.searchParams.has("seed") ? uuid(url.searchParams.get("seed")) : "";
  const cookie =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("__Host-openmuse-checkpoint="))
      ?.split("=")[1] ?? "";
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>浏览器存档恢复验证</title><style>body{max-width:850px;margin:60px auto;padding:24px;font:18px/1.9 system-ui;background:#f4f6fa;color:#192235}article{background:white;border:1px solid #ddd;border-radius:14px;padding:24px}code{color:#315ee5}button{padding:10px;font:inherit}</style></head><body><article><h1>浏览器存档恢复验证</h1><p>这是虚构测试数据，用于检查关闭后恢复；不涉及真实账号。</p><p>HttpOnly Cookie：<code>${escapeHtml(seed || cookie || "未设置")}</code></p><p>localStorage：<code id="local"></code></p><p>sessionStorage：<code id="session"></code></p><button type="button" id="clear">清空本页站点存储</button><p><a href="/demo-catalog">返回演示目录</a></p></article><script>const seed=${JSON.stringify(seed)};if(seed){localStorage.setItem('openmuse-checkpoint-marker',seed);sessionStorage.setItem('openmuse-checkpoint-marker',seed);history.replaceState(null,'','/demo-catalog/checkpoint-test');}function show(){document.getElementById('local').textContent=localStorage.getItem('openmuse-checkpoint-marker')||'未设置';document.getElementById('session').textContent=sessionStorage.getItem('openmuse-checkpoint-marker')||'未设置';}document.getElementById('clear').onclick=()=>{localStorage.clear();sessionStorage.clear();show();};show();</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...(seed
          ? {
              "Set-Cookie": `__Host-openmuse-checkpoint=${seed}; Path=/; Secure; HttpOnly; SameSite=Lax`,
            }
          : {}),
      },
    },
  );
}

export function fixturePage(url: URL): Response {
  const selected = fixtureProducts.find((item) => url.pathname.endsWith(`/item/${item.id}`));
  const query = (url.searchParams.get("q") ?? "").slice(0, 200);
  const products = fixtureProducts.filter(
    (item) => !query || `${item.name} ${item.category}`.includes(query),
  );
  const content = selected
    ? `<h2>${selected.name}</h2><p>型号：${selected.id}</p><p>商品价格：<strong>${selected.price}</strong></p><p>币种：JPY。演示数据，含税，不含运费。</p><a href="/demo-catalog">返回目录</a>`
    : `<form action="/demo-catalog"><label>搜索商品 <input name="q" aria-label="搜索商品" value="${escapeHtml(query)}" placeholder="例如：耳机"></label><button type="submit">搜索</button></form><h2>商品目录</h2>${products.map((item) => `<article><h3><a href="/demo-catalog/item/${item.id}">${item.name}</a></h3><p>${item.price} JPY · 演示数据</p></article>`).join("") || "<p>没有匹配商品</p>"}`;
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>演示商品目录</title><style>body{max-width:900px;margin:40px auto;padding:20px;font:18px/1.8 system-ui;background:#f5f6fa;color:#192235}header,article{background:white;padding:20px;border:1px solid #ddd;border-radius:10px;margin:15px 0}input,button{padding:12px;font:inherit}a{color:#2459d3}strong{font-size:30px}</style></head><body><header><h1>演示商品目录</h1><p>用于验证浏览器查价流程的虚构商品；本页所有金额都是演示数据，不是真实商家报价。</p></header>${content}</body></html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

function safeResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://live.browser.run; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  );
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/demo-catalog/checkpoint-test") return checkpointTestPage(url, request);
      if (url.pathname === "/demo-catalog" || url.pathname.startsWith("/demo-catalog/item/")) {
        return fixturePage(url);
      }
      if (!url.pathname.startsWith("/api/")) return safeResponse(await env.ASSETS.fetch(request));
      if (!authorized(request, env.DEMO_ACCESS_TOKEN)) {
        throw new DemoError("需要 demo 访问口令，或通过本地入口打开", 401, "unauthorized");
      }
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new DemoError("不接受跨站请求", 403, "forbidden");
      if (
        request.method === "POST" &&
        !request.headers.get("content-type")?.startsWith("application/json")
      ) {
        throw new DemoError("需要 application/json", 415, "invalid_content_type");
      }
      if (url.pathname === "/api/health") {
        return safeResponse(
          Response.json({
            ok: true,
            provider: "cloudflare-agents-and-browser-run",
            model: env.DEEPSEEK_MODEL,
            modelConfigured: Boolean(env.DEEPSEEK_API_KEY),
            catalogUrl: new URL("/demo-catalog", url).href,
          }),
        );
      }
      if (url.pathname === "/api/browser/limits" && request.method === "GET") {
        const limits = await puppeteer.limits(env.BROWSER);
        return safeResponse(
          Response.json({
            activeSessions: limits.activeSessions.length,
            maxConcurrentSessions: limits.maxConcurrentSessions,
            allowedBrowserAcquisitions: limits.allowedBrowserAcquisitions,
            timeUntilNextAllowedBrowserAcquisition: limits.timeUntilNextAllowedBrowserAcquisition,
          }),
        );
      }
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.DEMO_ACCESS_TOKEN)),
      );
      const owner = [...hash]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
      const agent = await getAgentByName(env.PRICE_AGENT, `owner-${owner}`);
      let action: DemoAction;
      if (url.pathname === "/api/state" && request.method === "GET") {
        action = {
          type: "snapshot",
          conversationId: url.searchParams.has("conversationId")
            ? uuid(url.searchParams.get("conversationId"))
            : null,
        };
      } else if (url.pathname === "/api/conversations" && request.method === "POST") {
        await readJson(request, 1024);
        action = { type: "create" };
      } else if (url.pathname === "/api/chat" && request.method === "POST") {
        const input = record(await readJson(request, 16_384));
        action = {
          type: "run",
          conversationId: uuid(input.conversationId),
          prompt: text(input.prompt, "消息", 4000),
          requestId: uuid(input.requestId),
        };
      } else if (url.pathname === "/api/stop" && request.method === "POST") {
        await readJson(request, 1024);
        action = { type: "stop" };
      } else if (url.pathname === "/api/browser/close" && request.method === "POST") {
        await readJson(request, 1024);
        action = { type: "close" };
      } else if (
        request.method === "POST" &&
        ["save", "save-close", "reconnect", "disconnect", "forget"].some(
          (operation) => url.pathname === `/api/browser/${operation}`,
        )
      ) {
        const input = record(await readJson(request, 1024));
        const operation = url.pathname.split("/").at(-1) as Extract<
          DemoAction,
          { type: "browser" }
        >["operation"];
        action = { type: "browser", operation, conversationId: uuid(input.conversationId) };
      } else if (url.pathname === "/api/browser/live" && request.method === "GET") {
        action = { type: "live", conversationId: uuid(url.searchParams.get("conversationId")) };
      } else {
        throw new DemoError("接口不存在", 404, "not_found");
      }
      const reply = record(JSON.parse(await agent.invoke(action)));
      if (reply.ok !== true) {
        const detail = record(reply.error);
        throw new DemoError(String(detail.message), Number(detail.status), String(detail.code));
      }
      const result =
        action.type === "snapshot"
          ? { ...record(reply.value), catalogUrl: new URL("/demo-catalog", url).href }
          : reply.value;
      return safeResponse(Response.json(result));
    } catch (error) {
      // Agent RPC can wrap application errors. Do not expose upstream errors or credentials.
      const status = error instanceof DemoError ? error.status : 500;
      const message = error instanceof DemoError ? error.message : "操作未成功，请稍后重试";
      const code = error instanceof DemoError ? error.code : "internal_error";
      console.error(JSON.stringify({ event: "demo_error", code, status }));
      return safeResponse(Response.json({ error: { code, message } }, { status }));
    }
  },
} satisfies ExportedHandler<Env>;
