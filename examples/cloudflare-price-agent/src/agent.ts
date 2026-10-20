import { Agent } from "agents";
import { type BrowserStatus, DemoBrowser } from "./browser";
import { type BrowserCheckpoint, checkpointInfo, encodeCheckpoint } from "./checkpoint";
import {
  completion,
  DemoError,
  type Evidence,
  type ModelMessage,
  SYSTEM_PROMPT,
  verifyEvidence,
} from "./core";

interface DemoState {
  running: { requestId: string; conversationId: string; startedAt: number } | null;
  browser: BrowserStatus | null;
  screenshot: string;
  events: { id: string; type: string; message: string; at: string }[];
  revision: number;
  checkpointError?: { conversationId: string; message: string } | null;
}

type Conversation = { id: string; title: string; created_at: string };
type Turn = {
  id: string;
  conversation_id: string;
  prompt: string;
  answer: string;
  status: string;
  model_json: string;
  prices_json: string;
  created_at: string;
};

export type DemoAction =
  | { type: "snapshot"; conversationId: string | null }
  | { type: "create" }
  | { type: "run"; conversationId: string; prompt: string; requestId: string }
  | { type: "stop" }
  | { type: "close" }
  | {
      type: "browser";
      operation: "save" | "save-close" | "reconnect" | "disconnect" | "forget";
      conversationId: string;
    }
  | { type: "live"; conversationId: string };

export class PriceAgent extends Agent<Env, DemoState> {
  initialState: DemoState = {
    running: null,
    browser: null,
    screenshot: "",
    events: [],
    revision: 0,
  };
  private controller: AbortController | null = null;
  private browserBusy = false;
  private browserDriver = new DemoBrowser(
    this.env.BROWSER,
    () => this.state.browser,
    (browser) => this.setState({ ...this.state, browser, revision: this.state.revision + 1 }),
    (screenshot) => this.setState({ ...this.state, screenshot, revision: this.state.revision + 1 }),
    async (sessionId) => {
      await this.schedule(1200, "expireBrowser", { sessionId });
    },
    {
      read: (id) => {
        const row = this.ctx.storage.sql
          .exec<{ profile_json: string }>(
            "SELECT profile_json FROM demo_browser_checkpoints WHERE conversation_id = ?",
            id,
          )
          .toArray()[0];
        return row ? (JSON.parse(row.profile_json) as BrowserCheckpoint) : null;
      },
      write: (id, checkpoint) => {
        const profile = encodeCheckpoint(checkpoint);
        this.ctx.storage.sql.exec(
          "INSERT INTO demo_browser_checkpoints(conversation_id, profile_json, info_json) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET profile_json = excluded.profile_json, info_json = excluded.info_json",
          id,
          profile,
          JSON.stringify(checkpointInfo(checkpoint)),
        );
        this.setState({ ...this.state, checkpointError: null, revision: this.state.revision + 1 });
      },
      failed: (conversationId, message) => {
        this.setState({ ...this.state, checkpointError: { conversationId, message } });
        this.event("error", message);
      },
    },
  );

  async invoke(action: DemoAction): Promise<string> {
    try {
      let value: unknown;
      switch (action.type) {
        case "snapshot":
          value = this.snapshot(action.conversationId);
          break;
        case "create":
          value = await this.createConversation();
          break;
        case "run":
          value = await this.run(action.conversationId, action.prompt, action.requestId);
          break;
        case "stop":
          value = await this.stop();
          break;
        case "close":
          value = await this.closeBrowser();
          break;
        case "browser":
          value = await this.browserOperation(action.conversationId, action.operation);
          break;
        case "live":
          value = await this.liveView(action.conversationId);
          break;
      }
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error:
          error instanceof DemoError
            ? { message: error.message, status: error.status, code: error.code }
            : { message: "操作未成功，请稍后重试", status: 500, code: "internal_error" },
      });
    }
  }

  onStart() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS demo_conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS demo_turns (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      prompt TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      model_json TEXT NOT NULL DEFAULT '[]', prices_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS demo_turns_conversation ON demo_turns(conversation_id, created_at)",
    );
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS demo_browser_checkpoints (
      conversation_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, info_json TEXT NOT NULL
    )`);
    if (this.state.running) {
      const answer = "上一次操作因服务中断而未完成，可以继续追问；未自动重放浏览器操作。";
      this.ctx.storage.sql.exec(
        "UPDATE demo_turns SET status = 'interrupted', answer = ? WHERE id = ? AND status = 'running'",
        answer,
        this.state.running.requestId,
      );
      this.setState({ ...this.state, running: null });
    }
  }

  private event(type: string, message: string) {
    this.setState({
      ...this.state,
      revision: this.state.revision + 1,
      events: [
        ...this.state.events,
        { id: crypto.randomUUID(), type, message, at: new Date().toISOString() },
      ].slice(-80),
    });
  }

  listConversations(): Conversation[] {
    return this.ctx.storage.sql
      .exec<Conversation>(
        "SELECT id, title, created_at FROM demo_conversations ORDER BY created_at DESC LIMIT 40",
      )
      .toArray();
  }

  async createConversation(): Promise<Conversation> {
    if (this.state.running || this.browserBusy)
      throw new DemoError("请先等待或停止当前操作", 409, "run_busy");
    if (this.listConversations().length >= 40)
      throw new DemoError("此 demo 最多保留 40 个对话", 409);
    this.browserBusy = true;
    try {
      await this.browserDriver.preserveAndClose();
      const conversation = {
        id: crypto.randomUUID(),
        title: "新对话",
        created_at: new Date().toISOString(),
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO demo_conversations(id, title, created_at) VALUES (?, ?, ?)",
        conversation.id,
        conversation.title,
        conversation.created_at,
      );
      this.setState({ ...this.state, events: [], screenshot: "" });
      return conversation;
    } finally {
      this.browserBusy = false;
    }
  }

  private requireConversation(id: string): Conversation {
    const row = this.ctx.storage.sql
      .exec<Conversation>("SELECT id, title, created_at FROM demo_conversations WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new DemoError("对话不存在", 404, "not_found");
    return row;
  }

  snapshot(conversationId: string | null) {
    if (conversationId) this.requireConversation(conversationId);
    const turns = conversationId
      ? this.ctx.storage.sql
          .exec<Turn>(
            "SELECT * FROM demo_turns WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 100",
            conversationId,
          )
          .toArray()
      : [];
    const saved = conversationId
      ? this.ctx.storage.sql
          .exec<{ info_json: string }>(
            "SELECT info_json FROM demo_browser_checkpoints WHERE conversation_id = ?",
            conversationId,
          )
          .toArray()[0]
      : null;
    return {
      conversations: this.listConversations(),
      turns: turns.map(({ model_json: _model, prices_json, ...turn }) => ({
        ...turn,
        prices: JSON.parse(prices_json) as Evidence[],
      })),
      running: this.state.running,
      browserBusy: this.browserBusy,
      checkpoint: saved ? (JSON.parse(saved.info_json) as ReturnType<typeof checkpointInfo>) : null,
      checkpointError:
        this.state.checkpointError?.conversationId === conversationId
          ? this.state.checkpointError.message
          : null,
      browser: this.state.browser?.conversationId === conversationId ? this.state.browser : null,
      events: this.state.events,
      revision: this.state.revision,
      model: this.env.DEEPSEEK_MODEL,
      screenshot:
        this.state.browser?.conversationId === conversationId ? this.state.screenshot : "",
    };
  }

  private history(conversationId: string): ModelMessage[] {
    const rows = this.ctx.storage.sql
      .exec<Pick<Turn, "model_json" | "prompt" | "answer">>(
        "SELECT model_json, prompt, answer FROM demo_turns WHERE conversation_id = ? AND status <> 'running' ORDER BY created_at DESC LIMIT 6",
        conversationId,
      )
      .toArray();
    const groups: ModelMessage[][] = [];
    let chars = 0;
    for (const row of rows) {
      const parsed = JSON.parse(row.model_json) as ModelMessage[];
      const group = parsed.length
        ? parsed
        : [
            { role: "user" as const, content: row.prompt },
            { role: "assistant" as const, content: row.answer },
          ];
      const size = JSON.stringify(group).length;
      if (chars + size > 130_000) break;
      chars += size;
      groups.unshift(group);
    }
    return groups.flat();
  }

  async run(conversationId: string, prompt: string, requestId: string) {
    this.requireConversation(conversationId);
    const existing = this.ctx.storage.sql
      .exec<Turn>("SELECT * FROM demo_turns WHERE id = ?", requestId)
      .toArray()[0];
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.prompt !== prompt) {
        throw new DemoError("请求 ID 已被另一个操作使用", 409, "request_conflict");
      }
      return { id: requestId, status: existing.status, answer: existing.answer, replay: true };
    }
    if (this.state.running || this.browserBusy)
      throw new DemoError("已有操作进行中，请先等待或停止", 409, "run_busy");
    if (!this.env.DEEPSEEK_API_KEY)
      throw new DemoError("尚未配置模型密钥", 503, "model_unconfigured");
    const previous = this.history(conversationId);
    this.ctx.storage.sql.exec(
      "INSERT INTO demo_turns(id, conversation_id, prompt, status, created_at) VALUES (?, ?, ?, 'running', ?)",
      requestId,
      conversationId,
      prompt,
      new Date().toISOString(),
    );
    this.ctx.storage.sql.exec(
      "UPDATE demo_conversations SET title = ? WHERE id = ? AND title = '新对话'",
      prompt.slice(0, 32),
      conversationId,
    );
    this.controller = new AbortController();
    const controller = this.controller;
    const timeout = setTimeout(() => controller.abort("本轮超过 5 分钟"), 300_000);
    this.setState({
      ...this.state,
      running: { requestId, conversationId, startedAt: Date.now() },
      events: [],
    });
    const current: ModelMessage[] = [{ role: "user", content: prompt }];
    const prices: Evidence[] = [];
    let toolCount = 0;
    let status = "done";
    let answer = "达到本轮操作上限。已核验的价格见记录，其余部分尚未完成，可以继续追问。";
    this.event("start", "开始处理，正在读取当前对话");
    try {
      for (let step = 0; step < 10; step++) {
        controller.signal.throwIfAborted();
        this.event("thinking", `正在判断下一步（${step + 1}/10）`);
        const assistant = await completion(
          this.env.DEEPSEEK_API_KEY,
          this.env.DEEPSEEK_MODEL,
          [
            { role: "system", content: `${SYSTEM_PROMPT}\n当前时间：${new Date().toISOString()}` },
            ...previous,
            ...current,
          ],
          controller.signal,
        );
        current.push(assistant);
        if (!assistant.tool_calls?.length) {
          answer = assistant.content ?? "本轮未获得有效回答。";
          break;
        }
        for (const call of assistant.tool_calls) {
          controller.signal.throwIfAborted();
          if (++toolCount > 16)
            throw new DemoError("已达到本轮 16 次操作上限，其余内容未完成，可以继续追问");
          this.event("tool", `执行 ${call.function.name}`);
          let result: unknown;
          try {
            const args: unknown = JSON.parse(call.function.arguments);
            if (call.function.name === "record_price") {
              const observation = await this.browserDriver.read(conversationId);
              const evidence = verifyEvidence(args, observation);
              prices.push(evidence);
              this.ctx.storage.sql.exec(
                "UPDATE demo_turns SET prices_json = ? WHERE id = ?",
                JSON.stringify(prices),
                requestId,
              );
              result = { success: true, recorded: evidence };
              this.event("price", `已记录：${evidence.name} · ${evidence.priceText}`);
            } else {
              result = await this.browserDriver.action(conversationId, call.function.name, args);
              this.event("read", "已读取页面，可在右侧查看浏览器");
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            const detail = error instanceof Error ? error : null;
            const upstreamStatus = detail?.message.match(
              /(?:code:|status:|response:)\s*(\d{3})/i,
            )?.[1];
            const quotaKind = detail?.message.match(
              /(?:Browser\w*Limit|Browser\w*Exceeded|(?:daily|concurrent|rate|time)[\w ]{0,50}(?:limit|exceeded))/i,
            )?.[0];
            console.error(
              JSON.stringify({
                event: "browser_operation_error",
                operation: call.function.name,
                stage: this.browserDriver.stage,
                kind: detail?.name ?? "unknown",
                locations: detail?.stack
                  ?.match(/(?:worker\.js|browser\.ts|agent\.ts):\d+:\d+/g)
                  ?.slice(0, 3),
                upstreamStatus,
                quotaKind,
              }),
            );
            if (error instanceof DemoError && error.code === "browser_rate_limited") throw error;
            const message =
              error instanceof DemoError
                ? error.message
                : upstreamStatus === "429"
                  ? `云端浏览器达到配额或速率限制${quotaKind ? `（${quotaKind}）` : ""}，请检查账户用量后重试`
                  : `浏览器操作未成功（${this.browserDriver.stage}），请稍后重试`;
            result = { success: false, error: message };
            this.event("error", message);
          }
          current.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      controller.signal.throwIfAborted();
      if (current.at(-1)?.role !== "assistant" || current.at(-1)?.tool_calls?.length) {
        current.push({ role: "assistant", content: answer });
      }
    } catch (error) {
      status = controller.signal.aborted ? "cancelled" : "error";
      answer = controller.signal.aborted
        ? "本轮操作已停止。已取得的价格记录保留；未自动重复任何浏览器操作。"
        : error instanceof DemoError
          ? `本轮未完成：${error.message}`
          : "本轮未完成：服务暂不可用，请重试。";
      current.splice(
        0,
        current.length,
        { role: "user", content: prompt },
        { role: "assistant", content: answer },
      );
      this.event("error", answer);
    } finally {
      clearTimeout(timeout);
      // Stop can arrive while launch() is pending. Close again after that action settles.
      if (controller.signal.aborted) {
        try {
          await this.browserDriver.close();
        } catch {
          this.event("error", "操作已停止，但尚未确认浏览器关闭成功，请点击关闭重试");
        }
      }
      this.ctx.storage.sql.exec(
        "UPDATE demo_turns SET status = ?, answer = ?, model_json = ?, prices_json = ? WHERE id = ?",
        status,
        answer,
        JSON.stringify(current),
        JSON.stringify(prices),
        requestId,
      );
      this.controller = null;
      this.setState({ ...this.state, running: null });
      this.event(
        status === "done" ? "done" : "error",
        status === "done" ? "本轮回答已返回" : "本轮操作未完成",
      );
    }
    return { id: requestId, status, answer };
  }

  async stop() {
    if (this.browserBusy) throw new DemoError("浏览器正在保存或连接，请稍后再试", 409, "run_busy");
    this.controller?.abort("用户停止");
    this.event("stop", "正在停止操作并关闭浏览器");
    await this.browserDriver.close();
    return { stopped: true };
  }

  async closeBrowser() {
    if (this.state.running || this.browserBusy) throw new DemoError("请先等待或停止当前操作", 409);
    this.browserBusy = true;
    try {
      await this.browserDriver.close();
      this.event("closed", "浏览器已关闭，已保存的存档、对话和价格记录仍保留");
      return { closed: true };
    } finally {
      this.browserBusy = false;
    }
  }

  async browserOperation(
    conversationId: string,
    operation: Extract<DemoAction, { type: "browser" }>["operation"],
  ) {
    this.requireConversation(conversationId);
    if (this.state.running || this.browserBusy)
      throw new DemoError("请先等待或停止当前操作", 409, "run_busy");
    this.browserBusy = true;
    try {
      if (operation === "reconnect") {
        const result = await this.browserDriver.reconnect(conversationId);
        this.event(
          "restored",
          result.mode === "restored"
            ? "已从存档恢复到新浏览器；网站可能要求重新登录"
            : "已重新连接原浏览器",
        );
        return result;
      }
      if (operation === "forget") {
        if (this.state.browser?.conversationId === conversationId)
          throw new DemoError("请先关闭浏览器，再删除已保存的存档", 409);
        this.ctx.storage.sql.exec(
          "DELETE FROM demo_browser_checkpoints WHERE conversation_id = ?",
          conversationId,
        );
        this.setState({ ...this.state, checkpointError: null });
        this.event("forgotten", "浏览器存档已删除，对话和价格记录仍保留");
        return { deleted: true };
      }
      if (this.state.browser && this.state.browser.conversationId !== conversationId)
        throw new DemoError("当前浏览器属于另一个对话，请切回该对话操作", 409);
      if (operation === "disconnect") {
        const result = await this.browserDriver.disconnect(conversationId);
        this.event("disconnected", "控制连接已断开，原浏览器可能仍运行并计费；可重连或直接关闭");
        return result;
      }
      const checkpoint = await this.browserDriver.save(conversationId);
      this.event("saved", "已保存当前页面、Cookie 和当前站点存储");
      if (operation === "save-close") {
        try {
          await this.browserDriver.close();
        } catch {
          throw new DemoError(
            "存档已保存，但尚未确认浏览器关闭成功，请点击直接关闭重试",
            502,
            "browser_close_failed",
          );
        }
        this.event("closed", "已保存并关闭浏览器，可点击恢复/重连继续");
      }
      return { checkpoint, closed: operation === "save-close" };
    } finally {
      this.browserBusy = false;
    }
  }

  async liveView(conversationId: string) {
    this.requireConversation(conversationId);
    if (this.browserBusy) return { url: null, sessionId: null };
    return {
      url: await this.browserDriver.liveView(conversationId),
      sessionId: this.state.browser?.sessionId ?? null,
    };
  }

  async expireBrowser(payload: { sessionId: string }) {
    if (this.state.browser?.sessionId !== payload.sessionId) return;
    this.controller?.abort("浏览器已达到 20 分钟时限");
    await this.browserDriver.close();
    this.event("closed", "浏览器已达到 20 分钟时限并关闭，可以在下一轮重新打开");
  }
}
