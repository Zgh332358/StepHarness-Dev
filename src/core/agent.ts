// Agent 主循环：调用模型 → 执行工具（必要时先请用户审批）→ 把结果交回模型 → 重复，直到模型不再调用工具。
import { randomUUID } from "node:crypto";
import { checkApproval } from "./approval.js";
import { sandboxAvailable } from "./sandbox.js";
import { buildTranscript, chooseCut, COMPACTION_SYSTEM, compactionLimit, contextEstimate, isOverflowError, keepBudget, summaryMessage } from "./compaction.js";
import { streamModel } from "./providers/index.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionStore } from "./session.js";
import { builtinTools, ToolError, type Tool } from "./tools/index.js";
import {
  emptyUsage, ProviderError,
  type ApprovalMode, type AssistantMessage, type ImageBlock, type Message, type ModelInfo,
  type StreamEvent, type TextBlock, type ThinkingLevel, type ToolCallBlock, type ToolResultMessage, type UserMessage,
} from "./types.js";

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  /** 是否提供"本会话都允许"选项 */
  canAllowSession: boolean;
  sessionKey?: string;
}
export interface ApprovalDecision { decision: "allow" | "allow_session" | "deny"; feedback?: string }

export interface SessionStats {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
  /** 最近一次请求占用的上下文 token 数 */
  contextTokens: number;
  contextWindow: number;
  toolCalls: number;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; reason: "done" | "aborted" | "error" | "denied" | "max_turns"; error?: string }
  | { type: "message"; message: Message }
  | { type: "assistant_start"; model: string }
  | { type: "assistant_delta"; event: StreamEvent }
  | { type: "tool_start"; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: "tool_update"; toolCallId: string; delta: string }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision["decision"] }
  | { type: "retry"; attempt: number; max: number; delayMs: number; error: string }
  | { type: "queue"; pending: string[] }
  | { type: "title"; title: string }
  | { type: "stats"; stats: SessionStats }
  | { type: "compaction_start"; reason: CompactionReason }
  | { type: "compaction_end"; reason: CompactionReason; ok: boolean; tokensBefore?: number; tokensAfter?: number; summary?: UserMessage; error?: string };

export type CompactionReason = "threshold" | "overflow" | "manual";

export interface AgentOptions {
  cwd: string;
  model: ModelInfo;
  /** 返回某个模型所属服务的 API Key */
  getApiKey: (model: ModelInfo) => string;
  thinking?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  session?: SessionStore;
  messages?: Message[];
  tools?: Tool[];
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  /** 重试的初始等待时间（毫秒），之后每次翻倍 */
  retryBaseMs?: number;
  /** 命令沙箱（仅 macOS 可用；不可用时自动关闭） */
  sandbox?: boolean;
  /** 沙箱里额外允许写入的目录 */
  sandboxWritableRoots?: string[];
  /** 自动压缩上下文（默认开启） */
  autoCompact?: boolean;
  /** 界面显示用的完整记录（含被压缩掉的旧消息），默认与 messages 相同 */
  display?: Message[];
  /** 替换模型调用（测试用） */
  stream?: typeof streamModel;
}

const MAX_RETRIES = 3;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

export class Agent {
  readonly cwd: string;
  model: ModelInfo;
  thinking: ThinkingLevel;
  approvalMode: ApprovalMode;
  readonly session: SessionStore;
  readonly messages: Message[];
  readonly tools: Tool[];

  private getApiKey: (model: ModelInfo) => string;
  private env: NodeJS.ProcessEnv;
  private maxTurns: number;
  private retryBaseMs: number;
  private _sandbox = false;
  sandboxWritableRoots: string[];
  autoCompact: boolean;
  /** 界面显示用的完整记录：压缩不会删除这里的消息，只会追加一条摘要 */
  readonly display: Message[];
  private stream: typeof streamModel;
  private _compacting = false;
  /** 压缩时调用模型产生的用量（这些调用不在消息历史里） */
  private compactionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  private listeners = new Set<(e: AgentEvent) => void>();
  private abortCtrl: AbortController | null = null;
  private queue: UserMessage[] = [];
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private sessionAllowed = new Set<string>();
  private _running = false;

  constructor(opts: AgentOptions) {
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.getApiKey = opts.getApiKey;
    this.thinking = opts.thinking ?? "low";
    this.approvalMode = opts.approvalMode ?? "auto-edit";
    this.session = opts.session ?? SessionStore.create(opts.cwd);
    this.messages = opts.messages ?? [];
    this.tools = opts.tools ?? builtinTools;
    this.env = opts.env ?? process.env;
    this.maxTurns = opts.maxTurns ?? 200;
    this.retryBaseMs = opts.retryBaseMs ?? 2000;
    this.sandbox = opts.sandbox ?? true;
    this.sandboxWritableRoots = opts.sandboxWritableRoots ?? [];
    this.autoCompact = opts.autoCompact ?? true;
    this.display = opts.display ?? [...this.messages];
    this.stream = opts.stream ?? streamModel;
  }

  get running() { return this._running; }
  /** 沙箱是否真正生效（请求开启且系统支持） */
  get sandbox() { return this._sandbox; }
  set sandbox(on: boolean) { this._sandbox = on && sandboxAvailable(); }
  get title() { return this.session.title; }

  on(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: AgentEvent) { for (const fn of this.listeners) { try { fn(e); } catch (err) { console.error(err); } } }

  private append(m: Message) {
    this.messages.push(m);
    this.display.push(m);
    this.session.append(m);
    this.emit({ type: "message", message: m });
  }

  // ---------- 对外接口 ----------

  /**
   * 发送用户消息。空闲时立即开始运行；运行中则放入队列，
   * 在当前这一步（工具执行完）之后、下一次调用模型之前送达。
   */
  async prompt(text: string, images: ImageBlock[] = []): Promise<"started" | "queued"> {
    const content: (TextBlock | ImageBlock)[] = [];
    if (text.trim()) content.push({ type: "text", text });
    content.push(...images);
    if (!content.length) throw new Error("消息不能为空");
    const msg: UserMessage = { role: "user", content, timestamp: Date.now() };

    if (this._compacting) throw new Error("正在压缩上下文，请稍候");
    if (this._running) {
      this.queue.push(msg);
      this.emitQueue();
      return "queued";
    }
    if (!this.session.title && text.trim()) this.setTitle(text.trim().replace(/\s+/g, " ").slice(0, 50));
    this.flushQueue(); // 上次中断后留下的排队消息先送出
    this.append(msg);
    void this.run();
    return "started";
  }

  abort() {
    this.abortCtrl?.abort();
    for (const [id, resolve] of this.pendingApprovals) { resolve({ decision: "deny" }); this.emit({ type: "approval_resolved", id, decision: "deny" }); }
    this.pendingApprovals.clear();
  }

  /** 清空排队中的消息，返回它们的文本 */
  clearQueue(): string[] {
    const texts = this.queue.map(userText);
    this.queue = [];
    this.emitQueue();
    return texts;
  }

  respondApproval(id: string, decision: ApprovalDecision) {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    resolve(decision);
    this.emit({ type: "approval_resolved", id, decision: decision.decision });
  }

  setTitle(title: string) {
    this.session.setTitle(title);
    this.emit({ type: "title", title });
  }

  get compacting() { return this._compacting; }

  /** 手动压缩（空闲时） */
  async compactNow(): Promise<boolean> {
    if (this._running || this._compacting) throw new Error("正在运行中，请等当前任务结束后再压缩");
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    try { return await this.compact("manual", ctrl.signal); } finally { this.abortCtrl = null; }
  }

  /**
   * 压缩上下文：把较早的消息总结成摘要，保留最近几轮原文。
   * 失败时上下文保持不变，返回 false。
   */
  private async compact(reason: CompactionReason, signal: AbortSignal): Promise<boolean> {
    const before = contextEstimate(this.messages);
    let cut = chooseCut(this.messages, keepBudget(this.model));
    if (cut === 0 || isSummaryOnlyBefore(this.messages, cut)) {
      // 估算认为全部都能保留，但实际用量已经超限（估算偏小，例如图片、大量代码）：
      // 改为在最近一条用户消息之前切分，保留用户最新的请求原文
      const lastUser = lastUserIndex(this.messages);
      if (lastUser > 0 && !isSummaryOnlyBefore(this.messages, lastUser)) cut = lastUser;
      else if (reason === "threshold") return false;      // 只剩最近一轮，阈值触发时不压缩
      else cut = this.messages.length;                     // 溢出或手动：全部总结
    }
    this._compacting = true;
    this.emit({ type: "compaction_start", reason });
    try {
      const apiKey = this.getApiKey(this.model);
      if (!apiKey) throw new Error(`服务「${this.model.provider}」还没有配置 API Key`);
      // 文字记录最多占模型窗口的 60%（按每 token 约 2.5 字符估算）
      const maxChars = Math.floor((this.model.contextWindow || 128000) * 0.6 * 2.5);
      const transcript = buildTranscript(this.messages.slice(0, cut), maxChars);
      const res = await this.stream({
        model: this.model, apiKey, system: COMPACTION_SYSTEM, tools: [], thinking: "off", signal,
        messages: [{ role: "user", content: [{ type: "text", text: `以下是需要压缩的对话记录：\n\n${transcript}\n\n请按要求写出摘要。` }], timestamp: Date.now() }],
        onEvent: () => {},
      });
      const summaryText = res.content.filter((b) => b.type === "text").map((b) => (b as TextBlock).text).join("\n").trim();
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) this.compactionUsage[k] += res.usage?.[k] ?? 0;
      if (res.stopReason === "error" || !summaryText) throw new Error(res.errorMessage || "模型没有返回摘要");
      if (signal.aborted) throw new Error("已中断");

      const summary = summaryMessage(summaryText, before, reason);
      const kept = this.messages.slice(cut);
      this.messages.splice(0, this.messages.length, summary, ...kept);
      this.display.push(summary);
      this.session.appendCompaction(summary, kept.length);
      const after = contextEstimate(this.messages);
      this.emit({ type: "compaction_end", reason, ok: true, tokensBefore: before, tokensAfter: after, summary });
      this.emit({ type: "stats", stats: this.stats() });
      return true;
    } catch (err) {
      this.emit({ type: "compaction_end", reason, ok: false, error: (err as Error).message });
      return false;
    } finally {
      this._compacting = false;
    }
  }

  stats(): SessionStats {
    const s: SessionStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: this.model.contextWindow, toolCalls: 0 };
    for (const m of this.messages) {
      if (m.role === "assistant") {
        s.input += m.usage.input; s.output += m.usage.output; s.cacheRead += m.usage.cacheRead; s.cacheWrite += m.usage.cacheWrite; s.cost += m.usage.cost;
        s.toolCalls += m.content.filter((b) => b.type === "toolCall").length;
      }
    }
    // 费用和 token 统计包含已被压缩掉的历史
    for (const m of this.display) if (m.role === "assistant" && !this.messages.includes(m)) {
      s.input += m.usage.input; s.output += m.usage.output; s.cacheRead += m.usage.cacheRead; s.cacheWrite += m.usage.cacheWrite; s.cost += m.usage.cost;
    }
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) s[k] += this.compactionUsage[k];
    s.contextTokens = this.messages.length ? contextEstimate(this.messages) : 0;
    return s;
  }

  // ---------- 主循环 ----------

  private async run() {
    this._running = true;
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    this.emit({ type: "agent_start" });
    let reason: Extract<AgentEvent, { type: "agent_end" }>["reason"] = "done";
    let error: string | undefined;

    let overflowRetried = false;
    try {
      for (let turn = 0; ; turn++) {
        if (turn >= this.maxTurns) { reason = "max_turns"; break; }
        if (ctrl.signal.aborted) { reason = "aborted"; break; }

        if (this.autoCompact && contextEstimate(this.messages) > compactionLimit(this.model)) {
          await this.compact("threshold", ctrl.signal);
          if (ctrl.signal.aborted) { reason = "aborted"; break; }
        }

        const assistant = await this.callModel(ctrl.signal);
        // 上下文超长：压缩后重试一次（不把这条错误留在历史里）
        if (assistant.stopReason === "error" && isOverflowError(assistant.errorMessage) && this.autoCompact && !overflowRetried) {
          overflowRetried = true;
          if (await this.compact("overflow", ctrl.signal)) { turn--; continue; }
        }
        overflowRetried = false;
        this.append(assistant);
        this.emit({ type: "stats", stats: this.stats() });
        if (assistant.stopReason === "aborted") { reason = "aborted"; break; }
        if (assistant.stopReason === "error") { reason = "error"; error = assistant.errorMessage; break; }

        const calls = assistant.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
        if (calls.length) {
          const outcome = await this.runTools(calls, ctrl.signal);
          if (outcome === "aborted") { reason = "aborted"; break; }
          if (outcome === "denied") { reason = "denied"; break; }
        }
        // 把排队的用户消息送进去
        const hadQueue = this.flushQueue();
        if (!calls.length && !hadQueue) break;
      }
    } catch (err) {
      reason = "error";
      error = (err as Error).message;
    } finally {
      this._running = false;
      this.abortCtrl = null;
      // 运行结束时还有排队消息（例如被中断）：保留在队列里，下一次 prompt 时一起发送
      this.emit({ type: "agent_end", reason, error });
      this.emit({ type: "stats", stats: this.stats() });
      if (reason === "done" && this.queue.length) {
        const next = this.queue.shift()!;
        this.emitQueue();
        this.append(next);
        void this.run();
      }
    }
  }

  private flushQueue(): boolean {
    if (!this.queue.length) return false;
    for (const m of this.queue) this.append({ ...m, timestamp: Date.now() });
    this.queue = [];
    this.emitQueue();
    return true;
  }

  private emitQueue() { this.emit({ type: "queue", pending: this.queue.map(userText) }); }

  /** 调用一次模型（带重试）。总是返回一条 assistant 消息，出错和中断也体现在 stopReason 里。 */
  private async callModel(signal: AbortSignal): Promise<AssistantMessage> {
    const model = this.model;
    const system = buildSystemPrompt({ cwd: this.cwd, model, tools: this.tools.map((t) => t.spec), sandbox: this.sandbox });
    const tools = this.tools.map((t) => t.spec);
    const history = sanitizeHistory(this.messages);

    for (let attempt = 0; ; attempt++) {
      this.emit({ type: "assistant_start", model: model.id });
      const partial: AssistantMessage = { role: "assistant", content: [], api: model.api, model: model.id, stopReason: "stop", usage: emptyUsage(), timestamp: Date.now() };
      let gotOutput = false;
      try {
        if (!model.id) throw new ProviderError("还没有选择模型：请先在设置里添加模型服务", 400, false);
        const apiKey = this.getApiKey(model);
        if (!apiKey) throw new ProviderError(`服务「${model.provider}」还没有配置 API Key，请在设置里填写`, 401, false);
        const msg = await this.stream({
          model, apiKey, system, messages: history, tools, thinking: this.thinking, signal,
          onEvent: (e) => { gotOutput = true; trackPartial(partial, e); this.emit({ type: "assistant_delta", event: e }); },
        });
        if (signal.aborted) return finalizeAborted(msg.content.length ? msg : partial);
        return msg;
      } catch (err) {
        if (signal.aborted) return finalizeAborted(partial);
        const e = err as ProviderError;
        if (e.retryable && !gotOutput && attempt < MAX_RETRIES) {
          const delayMs = this.retryBaseMs * 2 ** attempt;
          this.emit({ type: "retry", attempt: attempt + 1, max: MAX_RETRIES, delayMs, error: e.message });
          await sleep(delayMs, signal);
          if (signal.aborted) return finalizeAborted(partial);
          continue;
        }
        return { ...finalizeAborted(partial), stopReason: "error", errorMessage: e.message || String(err) };
      }
    }
  }

  /** 依次执行工具调用 */
  private async runTools(calls: ToolCallBlock[], signal: AbortSignal): Promise<"ok" | "aborted" | "denied"> {
    let stopped: "aborted" | "denied" | null = null;
    for (const call of calls) {
      if (stopped || signal.aborted) {
        this.append(toolResult(call, stopped === "denied" ? "已跳过：前一个操作被用户拒绝" : "已跳过：用户中断了运行", true));
        continue;
      }
      const tool = this.tools.find((t) => t.spec.name === call.name);
      if (!tool) { this.append(toolResult(call, `未知工具：${call.name}`, true)); continue; }
      if (call.arguments?._raw !== undefined) { this.append(toolResult(call, "工具参数不是合法的 JSON，请重新生成", true)); continue; }

      // 审批
      const check = checkApproval(tool, call.arguments, this.approvalMode, this.cwd, this.sessionAllowed, this.sandbox);
      if (check.needsApproval) {
        const decision = await this.requestApproval(call, check.reason || "执行操作", check.sessionKey);
        if (signal.aborted) { stopped = "aborted"; this.append(toolResult(call, "已跳过：用户中断了运行", true)); continue; }
        if (decision.decision === "deny") {
          const fb = decision.feedback?.trim();
          this.append(toolResult(call, `用户拒绝了这次操作。${fb ? `用户的说明：${fb}` : "请停下来，等待用户的进一步指示。"}`, true, { denied: true }));
          if (!fb) stopped = "denied";
          continue;
        }
        if (decision.decision === "allow_session" && check.sessionKey) for (const k of check.sessionKey.split("\n")) this.sessionAllowed.add(k);
      }

      // 执行
      this.emit({ type: "tool_start", toolCallId: call.id, name: call.name, args: call.arguments });
      let result: ToolResultMessage;
      try {
        const out = await tool.execute(call.arguments, {
          cwd: this.cwd, signal, env: this.env, sandbox: { enabled: this.sandbox, writableRoots: this.sandboxWritableRoots },
          onUpdate: (delta) => this.emit({ type: "tool_update", toolCallId: call.id, delta }),
        });
        result = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: out.content, isError: !!out.isError, details: out.details, timestamp: Date.now() };
      } catch (err) {
        const msg = err instanceof ToolError ? err.message : `工具执行出错：${(err as Error).message}`;
        result = toolResult(call, msg, true);
      }
      this.append(result);
      if (signal.aborted) stopped = "aborted";
    }
    return stopped ?? "ok";
  }

  private requestApproval(call: ToolCallBlock, reason: string, sessionKey?: string): Promise<ApprovalDecision> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, resolve);
      this.emit({ type: "approval_request", request: { id, toolCallId: call.id, toolName: call.name, args: call.arguments, reason, canAllowSession: !!sessionKey, sessionKey } });
    });
  }
}

// ---------- 辅助函数 ----------

/** 最后一条真正的用户消息（不是压缩摘要）的位置 */
function lastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.role === "user" && !m.compaction) return i; }
  return -1;
}
/** 切分点之前只有一条摘要（再压缩没有意义） */
function isSummaryOnlyBefore(messages: Message[], cut: number): boolean {
  return cut === 1 && messages[0].role === "user" && !!messages[0].compaction;
}

function userText(m: UserMessage): string {
  const t = m.content.filter((b) => b.type === "text").map((b) => (b as TextBlock).text).join(" ");
  const n = m.content.filter((b) => b.type === "image").length;
  return t + (n ? ` [${n} 张图片]` : "");
}

function toolResult(call: ToolCallBlock, text: string, isError: boolean, details?: Record<string, unknown>): ToolResultMessage {
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, details, timestamp: Date.now() };
}

/** 根据流式事件拼出部分回复（中断或出错时保留已经输出的内容） */
function trackPartial(p: AssistantMessage, e: StreamEvent) {
  const c = p.content;
  switch (e.type) {
    case "text_delta": { const b = c[e.index]; if (b?.type === "text") b.text += e.delta; else c[e.index] = { type: "text", text: e.delta }; break; }
    case "thinking_delta": { const b = c[e.index]; if (b?.type === "thinking") b.thinking += e.delta; else c[e.index] = { type: "thinking", thinking: e.delta }; break; }
    case "toolcall_start": c[e.index] = { type: "toolCall", id: e.id, name: e.name, arguments: {} }; break;
    case "block_end": c[e.index] = e.block; break;
  }
}

/** 中断后的回复：去掉没完成的工具调用和无法回放的思考块 */
function finalizeAborted(m: AssistantMessage): AssistantMessage {
  return {
    ...m,
    content: m.content.filter((b) => b && b.type === "text" && b.text),
    stopReason: "aborted",
  };
}

/**
 * 发送给模型前整理历史：保证每个工具调用都有对应结果，
 * 去掉中断/出错留下的空回复。
 */
function sanitizeHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => (m as ToolResultMessage).toolCallId));
  for (const m of messages) {
    if (m.role === "assistant") {
      if ((m.stopReason === "error" || m.stopReason === "aborted") && !m.content.some((b) => b.type === "text" && b.text.trim())) continue;
      out.push(m);
      for (const b of m.content) {
        if (b.type === "toolCall" && !answered.has(b.id)) {
          out.push({ role: "toolResult", toolCallId: b.id, toolName: b.name, content: [{ type: "text", text: "（没有结果：运行被中断）" }], isError: true, timestamp: m.timestamp });
        }
      }
    } else out.push(m);
  }
  return out;
}
