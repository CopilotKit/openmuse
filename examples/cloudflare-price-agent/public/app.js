const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("price-agent-access") || "";
let conversationId = localStorage.getItem("price-agent-conversation") || "";
let busy = false;
let sending = false;
let snapshot;
let lastRender = "";
let viewSession = "";
let refreshing = false;
let loadingView = false;
let catalogUrl = "";
let browserActionBusy = false;
let viewEpoch = 0;

const labels = {
  browser_search: "搜索网页",
  browser_navigate: "打开网页",
  browser_read: "读取当前页面",
  browser_click: "点击页面元素",
  browser_type: "填写搜索内容",
  browser_key: "按键操作",
  browser_scroll: "滚动页面",
  record_price: "核对并记录价格",
};

function error(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`服务未返回有效 JSON（HTTP ${response.status}）`);
  }
  if (response.status === 401) {
    $("workspace").hidden = true;
    $("login").hidden = false;
    $("connection").textContent = "需要连接";
  }
  if (!response.ok) {
    const cause = new Error(data.error?.message || `请求失败（HTTP ${response.status}）`);
    cause.status = response.status;
    throw cause;
  }
  return data;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

// Render only a small, text-based Markdown subset; model output never becomes HTML.
function inlineText(node, value) {
  const pattern =
    /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    node.append(document.createTextNode(value.slice(offset, match.index)));
    if (match[1] || match[2]) {
      node.append(element(match[1] ? "strong" : "code", "", match[1] || match[2]));
    } else {
      try {
        const url = new URL(match[4] || match[5]);
        const link = element("a", "", match[3] || url.href);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        node.append(link);
      } catch {
        node.append(document.createTextNode(match[0]));
      }
    }
    offset = match.index + match[0].length;
  }
  node.append(document.createTextNode(value.slice(offset)));
}

function assistantBody(content) {
  const body = element("div", "message-body formatted");
  const lines = content.split("\n");
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((x) => x.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("|") && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const wrap = element("div", "answer-table");
      const table = element("table");
      const head = element("thead");
      const row = element("tr");
      for (const value of cells(lines[i])) {
        const cell = element("th");
        inlineText(cell, value);
        row.append(cell);
      }
      head.append(row);
      table.append(head);
      const rows = element("tbody");
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = element("tr");
        for (const value of cells(lines[i])) {
          const cell = element("td");
          inlineText(cell, value);
          row.append(cell);
        }
        rows.append(row);
        i++;
      }
      i--;
      table.append(rows);
      wrap.append(table);
      body.append(wrap);
    } else {
      const line = element("div", "answer-line");
      inlineText(line, lines[i] || "\u00a0");
      body.append(line);
    }
  }
  return body;
}

function showMessage(role, content, failed = false) {
  const box = element("div", `message ${role}${failed ? " failed" : ""}`);
  box.append(element("div", "message-label", role === "user" ? "你" : "查价助手"));
  box.append(
    role === "assistant" ? assistantBody(content) : element("div", "message-body", content),
  );
  return box;
}

function setBusy(value) {
  busy = value;
  $("send").disabled = value || sending;
  $("new-chat").disabled = value || sending;
  $("stop").hidden = !value || browserActionBusy || Boolean(snapshot?.browserBusy);
  $("close-browser").disabled = value;
  $("run-note").textContent =
    browserActionBusy || snapshot?.browserBusy
      ? "正在保存或连接浏览器"
      : value
        ? "正在操作，可以随时停止"
        : "支持继续追问与比较";
}

function clearViewer() {
  viewEpoch++;
  viewSession = "";
  $("live-frame").removeAttribute("src");
  $("live-frame").hidden = true;
  $("screenshot").hidden = true;
  $("viewer-empty").hidden = false;
  $("open-live").hidden = true;
  $("open-live").removeAttribute("href");
}

async function loadLive(force = false) {
  if (
    loadingView ||
    browserActionBusy ||
    snapshot?.browserBusy ||
    snapshot?.browser?.connection === "disconnected"
  )
    return;
  if (!snapshot?.browser || !conversationId) return;
  if (!force && viewSession === snapshot.browser.sessionId) return;
  loadingView = true;
  const requestedConversation = conversationId;
  const epoch = viewEpoch;
  try {
    const live = await api(`/api/browser/live?conversationId=${conversationId}`);
    if (!live.url) return;
    if (
      epoch !== viewEpoch ||
      browserActionBusy ||
      snapshot?.browser?.connection === "disconnected" ||
      conversationId !== requestedConversation ||
      snapshot?.browser?.sessionId !== live.sessionId
    )
      return;
    const url = new URL(live.url);
    if (url.origin !== "https://live.browser.run")
      throw new Error("实时浏览器返回了不支持的查看地址");
    $("live-frame").src = url.href;
    $("live-frame").hidden = false;
    $("viewer-empty").hidden = true;
    $("screenshot").hidden = true;
    $("open-live").href = url.href;
    $("open-live").hidden = false;
    viewSession = live.sessionId;
  } catch (cause) {
    if (epoch !== viewEpoch || browserActionBusy) return;
    $("browser-status").textContent = "实时连接暂不可用，展示最近画面";
    if (snapshot.screenshot) {
      $("screenshot").src = `data:image/jpeg;base64,${snapshot.screenshot}`;
      $("screenshot").hidden = false;
      $("viewer-empty").hidden = true;
    }
    error(cause.message);
  } finally {
    loadingView = false;
  }
}

function render(data) {
  snapshot = data;
  catalogUrl = data.catalogUrl;
  $("model").textContent = data.model;
  $("workspace").hidden = false;
  $("login").hidden = true;
  $("connection").textContent = "已连接 Cloudflare";
  setBusy(Boolean(data.running) || data.browserBusy || browserActionBusy);
  const items = data.conversations.map((item) => {
    const button = element(
      "button",
      `conversation${item.id === conversationId ? " selected" : ""}`,
      item.title,
    );
    button.disabled = busy || sending;
    button.onclick = async () => {
      conversationId = item.id;
      localStorage.setItem("price-agent-conversation", conversationId);
      lastRender = "";
      clearViewer();
      await refresh();
    };
    return button;
  });
  $("conversations").replaceChildren(...items);
  const signature = JSON.stringify(data.turns.map((turn) => [turn.id, turn.status, turn.answer]));
  if (signature !== lastRender) {
    lastRender = signature;
    const messages = [];
    for (const turn of data.turns) {
      messages.push(showMessage("user", turn.prompt));
      if (turn.answer)
        messages.push(
          showMessage("assistant", turn.answer, !["done", "running"].includes(turn.status)),
        );
    }
    if (!messages.length) {
      const welcome = element("div", "welcome");
      welcome.append(element("h2", "", "给一个商品，\n一起核对价格。"));
      welcome.append(
        element(
          "p",
          "",
          "你可以指定型号、地区和币种，也可以继续追问另一家网站。右侧会显示浏览器和页面价格记录。",
        ),
      );
      messages.push(welcome);
    }
    $("messages").replaceChildren(...messages);
    $("messages").scrollTop = $("messages").scrollHeight;
  }
  const prices = data.turns.flatMap((turn) => turn.prices);
  $("price-count").textContent = `${prices.length} 条`;
  const cards = prices.map((price) => {
    const card = element("article", "price");
    card.append(element("h3", "", price.name), element("strong", "", price.priceText));
    const link = element("a", "", new URL(price.url).hostname);
    link.href = price.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    card.append(
      link,
      element("p", "", `${price.currency} · ${new Date(price.observedAt).toLocaleString()}`),
    );
    if (price.note) card.append(element("p", "", price.note));
    return card;
  });
  $("prices").replaceChildren(
    ...(cards.length
      ? cards
      : [
          element(
            "p",
            "muted",
            "记录会包含页面原价、币种、链接和采集时间。拖动或登录后，可以追问“继续当前页面”。",
          ),
        ]),
  );
  const events = data.events.map((event) =>
    element(
      "div",
      `event${event.type === "error" ? " error-event" : ""}`,
      `${new Date(event.at).toLocaleTimeString()} · ${event.message.replace(/^执行 (\w+)$/, (_, name) => labels[name] || "执行操作")}`,
    ),
  );
  $("events").replaceChildren(...events);
  const latest = data.events.at(-1)?.message || "准备就绪";
  $("progress").textContent = latest.replace(
    /^执行 (\w+)$/,
    (_, name) => labels[name] || "执行操作",
  );
  const disconnected = data.browser?.connection === "disconnected";
  $("browser-status").textContent = disconnected
    ? "控制连接已断开，浏览器可能仍计费"
    : data.browser
      ? "云端浏览器运行中，可查看或手动操作"
      : data.checkpoint
        ? "浏览器已关闭，可从存档恢复"
        : "浏览器已关闭";
  $("browser-url").textContent =
    data.browser?.url || data.checkpoint?.url || "发送任务后，助手会按需打开云端浏览器。";
  $("refresh-view").disabled = !data.browser || disconnected || busy;
  $("close-browser").disabled = !data.browser || busy;
  $("save-browser").disabled = !data.browser || disconnected || busy;
  $("save-close-browser").disabled = !data.browser || disconnected || busy;
  $("disconnect-browser").disabled = !data.browser || disconnected || busy;
  $("restore-browser").disabled = (!data.browser && !data.checkpoint) || busy;
  $("forget-checkpoint").hidden = !data.checkpoint;
  $("forget-checkpoint").disabled = Boolean(data.browser) || busy;
  $("checkpoint-status").className = data.checkpointError ? "save-error" : "";
  $("checkpoint-status").textContent =
    data.checkpointError ||
    (data.checkpoint
      ? `已保存 ${new Date(data.checkpoint.savedAt).toLocaleString()} · 当前页面与站点状态`
      : "尚无存档；助手浏览后会自动保存，手动操作后请点击保存");
  if (!data.browser || disconnected || browserActionBusy) {
    clearViewer();
    $("viewer-title").textContent = disconnected
      ? "已断开浏览器控制连接"
      : data.checkpoint
        ? "浏览器状态已保存"
        : "看助手一步步完成查价";
    $("viewer-note").textContent = disconnected
      ? "点击恢复 / 重连可连接原会话；要释放浏览器资源，请使用直接关闭或重连后保存并关闭。"
      : data.checkpoint
        ? "点击恢复 / 重连，重新打开保存的页面与站点状态。网站可能要求重新登录。"
        : "发送任务后会按需打开浏览器；可在这里查看或手动操作。";
  } else {
    void loadLive();
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    let data = await api(`/api/state${conversationId ? `?conversationId=${conversationId}` : ""}`);
    if (!conversationId) {
      const conversation =
        data.conversations[0] || (await api("/api/conversations", { method: "POST", body: "{}" }));
      conversationId = conversation.id;
      localStorage.setItem("price-agent-conversation", conversationId);
      data = await api(`/api/state?conversationId=${conversationId}`);
    }
    render(data);
  } catch (cause) {
    if (cause.status === 404) {
      conversationId = "";
      localStorage.removeItem("price-agent-conversation");
    }
    $("connection").textContent = "连接暂不可用";
    error(cause.message);
  } finally {
    refreshing = false;
  }
}

$("chat-form").onsubmit = async (event) => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt || busy || sending || !conversationId) return;
  error("");
  sending = true;
  setBusy(true);
  $("progress").textContent = "已发送，正在处理…";
  const input = { conversationId, prompt, requestId: crypto.randomUUID() };
  $("prompt").value = "";
  try {
    await api("/api/chat", { method: "POST", body: JSON.stringify(input) });
  } catch (cause) {
    error(`${cause.message}。可以刷新查看服务器保存的实际状态，请勿重复提交同一任务。`);
  } finally {
    sending = false;
    await refresh();
  }
};
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) $("chat-form").requestSubmit();
};
$("new-chat").onclick = async () => {
  try {
    const conversation = await api("/api/conversations", { method: "POST", body: "{}" });
    conversationId = conversation.id;
    localStorage.setItem("price-agent-conversation", conversationId);
    lastRender = "";
    clearViewer();
    error("");
    await refresh();
  } catch (cause) {
    error(cause.message);
  }
};
$("stop").onclick = async () => {
  try {
    await api("/api/stop", { method: "POST", body: "{}" });
    await refresh();
  } catch (cause) {
    error(cause.message);
  }
};
async function browserOperation(operation) {
  if (busy || sending || browserActionBusy || !conversationId) return;
  browserActionBusy = true;
  setBusy(true);
  error("");
  if (operation !== "save") clearViewer();
  try {
    await api(`/api/browser/${operation}`, {
      method: "POST",
      body: JSON.stringify({ conversationId }),
    });
  } catch (cause) {
    error(cause.message);
  } finally {
    browserActionBusy = false;
    await refresh();
  }
}
$("close-browser").onclick = () => {
  void browserOperation("close");
};
$("save-browser").onclick = () => {
  void browserOperation("save");
};
$("save-close-browser").onclick = () => {
  void browserOperation("save-close");
};
$("restore-browser").onclick = () => {
  void browserOperation("reconnect");
};
$("disconnect-browser").onclick = () => {
  void browserOperation("disconnect");
};
$("forget-checkpoint").onclick = () => {
  void browserOperation("forget");
};
$("refresh-view").onclick = () => {
  void loadLive(true);
};
$("example-demo").onclick = () => {
  $("prompt").value =
    "打开演示目录，在搜索框输入“耳机”并搜索，找出最便宜的两款。进入商品页核对并记录价格、币种和链接，明确说明是演示数据。演示目录网址：" +
    catalogUrl;
  $("prompt").focus();
};
$("example-public").onclick = () => {
  $("prompt").value =
    "搜索 Cloudflare Browser Run 的价格，打开官方页面核对浏览器时长费和并发费，附来源链接。若搜索受限可以直接打开 https://developers.cloudflare.com/browser-run/pricing/ 并如实说明。";
  $("prompt").focus();
};
$("continue").onclick = () => {
  $("prompt").value = "继续当前页面，先重新读取，再完成刚才未完成的价格核对。";
  $("prompt").focus();
};
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  token = $("access-token").value.trim();
  try {
    await api("/api/health");
    sessionStorage.setItem("price-agent-access", token);
    $("access-token").value = "";
    await refresh();
  } catch (cause) {
    $("login-error").textContent = cause.message;
  }
};
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 2000);
