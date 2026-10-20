import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fetch, ProxyAgent } from "undici";

const file =
  process.env.OPENMUSE_CF_SETTINGS ||
  join(homedir(), ".config/openmuse-cloudflare-demo/settings.json");
const settings = JSON.parse(await readFile(file, "utf8"));
const remote = new URL(settings.url);
if (remote.protocol !== "https:" || !remote.hostname.endsWith(".workers.dev")) {
  throw new Error("Settings must contain a deployed HTTPS workers.dev URL");
}
if (typeof settings.accessToken !== "string" || settings.accessToken.length < 32) {
  throw new Error("Settings are missing the demo access token");
}
const port = Number(process.env.OPENMUSE_CF_PORT || 8791);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const server = createServer(async (request, response) => {
  const send = (status, message) => {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: { message } }));
  };
  try {
    if (
      !allowedHosts.has(request.headers.host) ||
      (request.headers.origin && !allowedOrigins.has(request.headers.origin))
    ) {
      send(403, "仅接受本机同源请求");
      return;
    }
    if (!["GET", "POST"].includes(request.method)) {
      send(405, "不支持此方法");
      return;
    }
    const target = new URL(request.url, remote.origin);
    if (target.origin !== remote.origin) {
      send(400, "无效请求地址");
      return;
    }
    let body;
    if (request.method === "POST") {
      const parts = [];
      let total = 0;
      for await (const part of request) {
        total += part.length;
        if (total > 16384) {
          send(413, "请求内容过大");
          return;
        }
        parts.push(part);
      }
      body = Buffer.concat(parts);
    }
    const headers = {
      Authorization: `Bearer ${settings.accessToken}`,
      ...(request.headers["content-type"]
        ? { "Content-Type": request.headers["content-type"] }
        : {}),
      ...(request.headers.origin ? { Origin: remote.origin } : {}),
    };
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(360_000),
    });
    const outgoing = {};
    for (const [name, value] of upstream.headers) {
      if (
        ![
          "content-encoding",
          "content-length",
          "transfer-encoding",
          "connection",
          "set-cookie",
        ].includes(name)
      )
        outgoing[name] = value;
    }
    response.writeHead(upstream.status, outgoing);
    if (upstream.body)
      Readable.fromWeb(upstream.body)
        .on("error", () => response.destroy())
        .pipe(response);
    else response.end();
  } catch {
    if (!response.headersSent) send(502, "无法连接 Cloudflare demo，请检查网络和部署状态");
    else response.destroy();
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Cloudflare price agent: http://127.0.0.1:${port}`);
  console.log("API access token stays in this local process; model and browser run on Cloudflare.");
});
