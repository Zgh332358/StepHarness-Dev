// StepHarness 界面（渲染进程）。只通过 window.stepharness.call / onEvent 与主进程里的内核通信。
import type {
  AgentEvent, ApprovalMode, ApprovalRequest, AssistantMessage, ImageBlock, Message, ModelInfo, SessionMeta,
  SessionStats, StreamEvent, ThinkingLevel, ToolCallBlock, ToolResultMessage,
} from "../core/index.js";

declare global {
  interface Window { stepharness: { call: (method: string, ...args: any[]) => Promise<any>; onEvent: (fn: (ev: any) => void) => () => void; platform: string } }
}
interface Snapshot {
  cwd: string; home: string; sessionFile: string | null; title: string; messages: Message[]; running: boolean;
  model: ModelInfo; thinking: ThinkingLevel; approvalMode: ApprovalMode; stats: SessionStats; queue: string[];
  approvals: ApprovalRequest[]; recentCwds: string[]; docs: string[]; modelKey: string; providerCount: number;
  compacting: boolean; sandbox: boolean; sandboxAvailable: boolean; autoCompact: boolean;
}
type UiEvent = AgentEvent | { type: "reset"; snapshot: Snapshot } | { type: "menu"; action: string } | { type: "model_changed"; model: ModelInfo; modelKey: string; providerCount: number };
interface Item { msg: Message; el?: HTMLElement }
interface ModelRow { key: string; id: string; provider: string; providerName: string; input: string[]; reasoning: boolean }
interface ProviderView { id: string; name: string; api: string; baseUrl: string; apiKeyEnv?: string; headers?: Record<string, string>; models: { id: string; [k: string]: unknown }[]; key: { source: string; ok: boolean } }
interface Preset { id: string; name: string; api: string; baseUrl: string; apiKeyEnv?: string; note?: string }
const API_LABEL: Record<string, string> = { "anthropic-messages": "Anthropic Messages", "openai-completions": "OpenAI Chat Completions", "openai-responses": "OpenAI Responses" };

import { esc, md } from "./markdown.js";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const call = window.stepharness.call;

const S = {
  snap: null as Snapshot | null,
  models: [] as ModelRow[],
  items: [] as Item[],
  streaming: null as Item | null,
  rawArgs: new Map<number, string>(),
  results: new Map<string, ToolResultMessage>(),
  exec: new Map<string, { running: boolean; live: string }>(),
  open: new Map<string, boolean>(),
  approvals: new Map<string, ApprovalRequest>(), // toolCallId -> 请求
  attachments: [] as { data: string; mimeType: string; url: string }[],
  sessions: [] as SessionMeta[],
  busy: false,
};

// ======================= 渲染 =======================
const thread = $("#thread"), messagesEl = $("#messages");
const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
const toBottom = () => { thread.scrollTop = thread.scrollHeight; };
const textOf = (c: Message["content"]) => (c as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const imagesOf = (c: Message["content"]) => (c as any[]).filter((b) => b.type === "image") as ImageBlock[];
const imgTag = (b: ImageBlock) =>
  /^image\/(png|jpeg|gif|webp)$/.test(b.mimeType) && /^[A-Za-z0-9+/]*={0,2}$/.test(b.data) ? `<img src="data:${b.mimeType};base64,${b.data}" />` : `<span class="note">[无效的图片数据]</span>`;
const short = (p?: string) => { const h = S.snap?.home, c = S.snap?.cwd; if (!p) return ""; if (c && p.startsWith(c + "/")) return p.slice(c.length + 1); return h && p.startsWith(h) ? "~" + p.slice(h.length) : p; };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…（共 ${s.length} 字符）` : s);
const tryJson = (s?: string) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const LABEL: Record<string, string> = { bash: "运行", read: "读取", edit: "编辑", write: "写入" };

function diffHtml(diff: { t: string; s: string; a?: number; b?: number }[]): string {
  return `<div class="diff">${diff.map((d) => d.s === "⋯" && d.t === " " && d.a == null
    ? `<div class="gap"><span class="ln"></span><span class="tx">⋯</span></div>`
    : `<div class="${d.t === "+" ? "p" : d.t === "-" ? "m" : ""}"><span class="ln">${d.t === "-" ? d.a ?? "" : d.b ?? ""}</span><span class="tx">${d.t === " " ? " " : d.t} ${esc(d.s)}</span></div>`).join("")}</div>`;
}

function toolCard(tc: ToolCallBlock, rawIndex?: number): string {
  const id = tc.id;
  const args: Record<string, any> = Object.keys(tc.arguments || {}).length ? tc.arguments : tryJson(rawIndex != null ? S.rawArgs.get(rawIndex) : "") || {};
  const res = S.results.get(id);
  const ex = S.exec.get(id);
  const approval = S.approvals.get(id);
  const streamingArgs = !res && !ex && !approval && S.streaming?.msg.content.includes(tc as any);
  const running = !res && (ex?.running || streamingArgs);
  const details = (res?.details || {}) as Record<string, any>;
  const out = res ? textOf(res.content) : ex?.live || "";

  let arg = "", status = "", body = "", link = "", badge = "";
  switch (tc.name) {
    case "bash":
      arg = String(args.command ?? "").replace(/\n/g, " ↵ ");
      body = `<pre>${esc(clip(out, 40000)) || (running ? "" : "(无输出)")}</pre>`;
      if (res && details.durationMs > 1500) status = `<span>${(details.durationMs / 1000).toFixed(1)}s</span>`;
      if (res && details.sandboxed === true) badge = `<span class="sbx" title="在沙箱中运行：只能写工作区和临时目录，不能访问外网">沙箱</span>`;
      else if (res && args.unsandboxed === true) badge = `<span class="sbx out" title="经你批准，在沙箱外运行">沙箱外</span>`;
      break;
    case "read":
      arg = short(args.path) + (args.offset ? `:${args.offset}` : ""); link = details.path || "";
      body = `<pre>${esc(clip(out, 8000))}</pre>`;
      if (res && details.total) status = `<span>${details.to - details.from + 1} 行</span>`;
      break;
    case "edit": case "write":
      arg = short(args.path); link = details.path || "";
      if (details.diff) { body = diffHtml(details.diff); status = `<span class="add">+${details.added}</span><span class="del">-${details.removed}</span>`; }
      else if (tc.name === "edit" && Array.isArray(args.edits)) {
        body = diffHtml(args.edits.flatMap((e: any, k: number) => [
          ...(k ? [{ t: " ", s: "⋯" }] : []),
          ...String(e?.oldText ?? "").split("\n").map((s) => ({ t: "-", s })),
          ...String(e?.newText ?? "").split("\n").map((s) => ({ t: "+", s })),
        ]));
      } else if (tc.name === "write") body = diffHtml(clip(String(args.content ?? ""), 20000).split("\n").map((s, i) => ({ t: "+", s, b: i + 1 })));
      if (res?.isError) body += `<pre>${esc(out)}</pre>`;
      break;
    default:
      arg = JSON.stringify(args);
      body = `<pre>${esc(JSON.stringify(args, null, 2))}\n\n${esc(clip(out, 20000))}</pre>`;
  }
  const imgs = res ? imagesOf(res.content) : [];
  if (imgs.length) body += `<div style="padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap">${imgs.map(imgTag).join("")}</div>`;

  let st: string;
  if (approval) st = `<span class="s wait">等待批准</span>`;
  else if (running) st = `<span class="s"><span class="spin"></span></span>`;
  else if (res?.details?.denied) st = `<span class="s bad">已拒绝</span>`;
  else if (res?.isError) st = `<span class="s bad">${badge}${tc.name === "bash" && details.signal ? "已中断" : tc.name === "bash" && details.timedOut ? "超时" : tc.name === "bash" && details.exitCode != null ? `退出码 ${details.exitCode}` : "失败"}</span>`;
  else if (res) st = `<span class="s ok">${badge}${status || "✓"}</span>`;
  else st = `<span class="s"></span>`;

  const defOpen = !!approval || !!res?.isError && !res?.details?.denied || tc.name === "edit" || tc.name === "write" || (tc.name === "bash" && !!ex?.running);
  const open = S.open.has(id) ? S.open.get(id)! : defOpen;

  let approvalHtml = "";
  if (approval) {
    approvalHtml = `<div class="approval" data-approval="${esc(approval.id)}">
      <div class="q">⚠ 需要你的批准：<b>${esc(approval.reason)}</b></div>
      <div class="row">
        <button class="yes" data-d="allow">允许<kbd>⌘⏎</kbd></button>
        ${approval.canAllowSession ? `<button data-d="allow_session" title="${esc(sessionKeyLabel(approval))}">本会话都允许</button>` : ""}
        <button class="no" data-d="deny">拒绝</button>
        <input placeholder="拒绝并告诉它该怎么做（回车发送）" />
      </div></div>`;
  }
  return `<div class="tool${approval ? " pending" : ""}${res?.isError ? " error" : ""}" data-tool="${esc(id)}">
    <div class="tool-head"><span class="k">${esc(LABEL[tc.name] || tc.name)}</span><span class="a${link ? " link" : ""}"${link ? ` data-path="${esc(link)}" title="在访达中显示"` : ""}>${esc(arg)}</span>${st}</div>
    ${open && body ? `<div class="tool-body">${body}</div>` : ""}${approvalHtml}</div>`;
}

function sessionKeyLabel(a: ApprovalRequest): string {
  const k = a.sessionKey || "";
  if (k === "write:workspace") return "本会话内不再询问工作区内的文件修改";
  if (k.startsWith("exec:")) return `本会话内不再询问这些命令：${k.split("\n").map((x) => x.slice(5)).join("、")}`;
  return "本会话内不再询问同类操作";
}

function assistantHtml(msg: AssistantMessage, streaming: boolean): string {
  let html = "";
  const n = msg.content.length;
  msg.content.forEach((b, i) => {
    if (!b) return;
    const last = streaming && i === n - 1;
    if (b.type === "thinking") {
      if (!b.thinking) return;
      html += `<details class="thinking"${last ? " open" : ""}><summary>${last ? "思考中…" : "思考过程"}</summary><div class="body">${esc(b.thinking)}</div></details>`;
    } else if (b.type === "text") {
      if (b.text) html += `<div class="md${last ? " cursor" : ""}">${md(b.text)}</div>`;
    } else html += toolCard(b, i);
  });
  if (msg.stopReason === "error") html += `<div class="err">⚠ ${esc(msg.errorMessage || "请求出错")}</div>`;
  else if (msg.stopReason === "aborted") html += `<div class="note">已中断</div>`;
  else if (msg.stopReason === "length") html += `<div class="note">输出达到长度上限</div>`;
  if (streaming && !html) html = `<div class="working">正在思考</div>`;
  return html;
}

function renderItem(item: Item): HTMLElement {
  const el = item.el || (item.el = document.createElement("div"));
  const m = item.msg;
  if (m.role === "user" && m.compaction) {
    el.className = "compaction";
    const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(0) + "k" : String(n));
    const why = { threshold: "上下文接近上限，已自动压缩", overflow: "上下文超出上限，已自动压缩", manual: "已手动压缩上下文" }[m.compaction.reason] || "上下文已压缩";
    const text = textOf(m.content).replace(/^[\s\S]*?<summary>\n?/, "").replace(/\n?<\/summary>[\s\S]*$/, "");
    el.innerHTML = `<div class="line"><span>${esc(why)}（之前约 ${k(m.compaction.tokensBefore)} tokens）· 以上内容模型已只能看到摘要</span></div>
      <details><summary>查看摘要</summary><div class="md">${md(text)}</div></details>`;
  } else if (m.role === "user") {
    el.className = "user";
    const imgs = imagesOf(m.content);
    el.innerHTML = (imgs.length ? `<div class="imgs">${imgs.map(imgTag).join("")}</div>` : "") + esc(textOf(m.content));
  } else if (m.role === "assistant") {
    el.className = "asst";
    el.innerHTML = assistantHtml(m, item === S.streaming);
    if (!el.innerHTML) el.classList.add("hidden");
  }
  return el;
}

function addItem(msg: Message): Item {
  const item: Item = { msg };
  S.items.push(item);
  messagesEl.appendChild(renderItem(item));
  $("#empty").classList.add("hidden");
  return item;
}

function renderAll() {
  const snap = S.snap!;
  S.items = []; S.streaming = null; S.results.clear(); S.exec.clear(); S.approvals.clear(); S.rawArgs.clear();
  messagesEl.innerHTML = "";
  for (const m of snap.messages) if (m.role === "toolResult") S.results.set(m.toolCallId, m);
  for (const a of snap.approvals) S.approvals.set(a.toolCallId, a);
  for (const m of snap.messages) if (m.role !== "toolResult") addItem(m);
  $("#empty").classList.toggle("hidden", S.items.length > 0);
  working();
  toBottom();
}

function updateTool(id: string) {
  const el = messagesEl.querySelector(`[data-tool="${CSS.escape(id)}"]`);
  if (!el) return;
  for (const item of S.items) {
    if (item.msg.role !== "assistant") continue;
    const idx = item.msg.content.findIndex((b) => b?.type === "toolCall" && b.id === id);
    if (idx < 0) continue;
    const stick = nearBottom();
    const focused = document.activeElement?.closest?.(".approval") && el.contains(document.activeElement);
    const draft = focused ? (document.activeElement as HTMLInputElement).value : null;
    el.outerHTML = toolCard(item.msg.content[idx] as ToolCallBlock, idx);
    const fresh = messagesEl.querySelector(`[data-tool="${CSS.escape(id)}"]`)!;
    const body = fresh.querySelector(".tool-body");
    if (body && S.exec.get(id)?.running) body.scrollTop = body.scrollHeight;
    if (draft != null) { const inp = fresh.querySelector<HTMLInputElement>(".approval input"); if (inp) { inp.value = draft; inp.focus(); } }
    if (stick) toBottom();
    return;
  }
}

const pendingRender = new Set<Item>();
function schedule(item: Item) {
  pendingRender.add(item);
  if (pendingRender.size > 1) return;
  requestAnimationFrame(() => {
    const stick = nearBottom();
    for (const it of pendingRender) renderItem(it);
    pendingRender.clear();
    if (stick) toBottom();
  });
}

function working() {
  let w = $("#working");
  const compacting = !!S.snap?.compacting;
  const show = compacting || (S.busy && !S.streaming && !S.approvals.size && ![...S.exec.values()].some((e) => e.running));
  if (show) {
    if (!w) { w = document.createElement("div"); w.id = "working"; w.className = "working"; }
    w.textContent = compacting ? "正在压缩上下文" : "工作中";
    messagesEl.appendChild(w);
  } else w?.remove();
}

// ======================= 事件处理 =======================
function applyDelta(item: Item, e: StreamEvent) {
  const c = (item.msg as AssistantMessage).content as any[];
  switch (e.type) {
    case "text_delta": if (c[e.index]?.type === "text") c[e.index].text += e.delta; else c[e.index] = { type: "text", text: e.delta }; break;
    case "thinking_delta": if (c[e.index]?.type === "thinking") c[e.index].thinking += e.delta; else c[e.index] = { type: "thinking", thinking: e.delta }; break;
    case "toolcall_start": c[e.index] = { type: "toolCall", id: e.id, name: e.name, arguments: {} }; S.rawArgs.set(e.index, ""); break;
    case "toolcall_delta": S.rawArgs.set(e.index, (S.rawArgs.get(e.index) || "") + e.delta); break;
    case "block_end": c[e.index] = e.block; break;
  }
}

const toolTimers = new Map<string, number>();
function onEvent(e: UiEvent) {
  switch (e.type) {
    case "reset": applySnapshot(e.snapshot); break;
    case "menu":
      if (e.action === "new") newSession();
      else if (e.action === "open") chooseWorkspace();
      else if (e.action === "settings") openSettings();
      break;
    case "agent_start": setBusy(true); break;
    case "agent_end":
      S.streaming = null; setBusy(false); setStatus("");
      if (e.reason === "max_turns") toast("已达到单次运行的最大步数，已暂停", "error");
      if (e.reason === "error" && e.error && !S.items.some((i) => i.msg.role === "assistant" && (i.msg as AssistantMessage).errorMessage === e.error)) toast(e.error, "error");
      loadSessions();
      break;
    case "assistant_start": {
      // 重试时丢弃上一次没成功的占位
      if (S.streaming) { S.streaming.el?.remove(); S.items = S.items.filter((i) => i !== S.streaming); }
      S.rawArgs.clear();
      const stick = nearBottom();
      S.streaming = addItem({ role: "assistant", content: [], api: "anthropic-messages", model: e.model, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, timestamp: Date.now() });
      renderItem(S.streaming);
      working(); setStatus("");
      if (stick) toBottom();
      break;
    }
    case "assistant_delta": if (S.streaming) { applyDelta(S.streaming, e.event); schedule(S.streaming); } break;
    case "message": {
      const m = e.message;
      if (m.role === "user") { addItem(m); toBottom(); if (!S.snap!.title) refreshTitle(); }
      else if (m.role === "assistant") {
        const it = S.streaming ?? addItem(m);
        it.msg = m; S.streaming = null; S.rawArgs.clear();
        renderItem(it);
      } else {
        S.results.set(m.toolCallId, m);
        const ex = S.exec.get(m.toolCallId); if (ex) ex.running = false;
        updateTool(m.toolCallId);
      }
      working();
      break;
    }
    case "tool_start": S.exec.set(e.toolCallId, { running: true, live: "" }); updateTool(e.toolCallId); working(); break;
    case "tool_update": {
      const ex = S.exec.get(e.toolCallId); if (!ex) break;
      ex.live = (ex.live + e.delta).slice(-60000);
      if (!toolTimers.has(e.toolCallId)) toolTimers.set(e.toolCallId, window.setTimeout(() => { toolTimers.delete(e.toolCallId); updateTool(e.toolCallId); }, 100));
      break;
    }
    case "approval_request": S.approvals.set(e.request.toolCallId, e.request); updateTool(e.request.toolCallId); working(); setStatus("等待你的批准"); break;
    case "approval_resolved":
      for (const [tid, r] of S.approvals) if (r.id === e.id) { S.approvals.delete(tid); updateTool(tid); }
      working(); setStatus("");
      break;
    case "retry": setStatus(`请求失败，${Math.round(e.delayMs / 1000)} 秒后重试（${e.attempt}/${e.max}）：${e.error}`); break;
    case "queue": renderQueue(e.pending); break;
    case "title": S.snap!.title = e.title; refreshTitle(); loadSessions(); break;
    case "stats": S.snap!.stats = e.stats; renderStats(); break;
    case "model_changed": S.snap!.providerCount = e.providerCount; applyModel(e.model, e.modelKey); break;
    case "compaction_start":
      S.snap!.compacting = true;
      setStatus(e.reason === "manual" ? "正在压缩上下文…" : "上下文接近上限，正在自动压缩…");
      working();
      break;
    case "compaction_end":
      S.snap!.compacting = false;
      setStatus("");
      if (e.ok && e.summary) { addItem(e.summary); toBottom(); }
      else if (!e.ok) toast(`压缩上下文失败：${e.error ?? "未知错误"}`, "error");
      working();
      break;
  }
}

// ======================= 顶栏 / 侧栏 =======================
function applySnapshot(snap: Snapshot) {
  S.snap = snap;
  S.open.clear();
  renderAll();
  setBusy(snap.running);
  refreshTitle();
  $("#ws-name").textContent = short(snap.cwd) || snap.cwd; $("#ws-btn").title = snap.cwd + "\n点击切换工作区（⌘O）";
  $("#empty-ws").textContent = snap.cwd.startsWith(snap.home) ? "~" + snap.cwd.slice(snap.home.length) : snap.cwd;
  $("#empty-docs").textContent = snap.docs.length ? `已加载项目说明：${snap.docs.map((d) => d.split("/").pop()).join("、")}` : "";
  $("#ws-name").textContent = snap.cwd === snap.home ? "~" : snap.cwd.split("/").pop() || snap.cwd;
  applyModel(snap.model, snap.modelKey);
  $<HTMLSelectElement>("#thinking").value = snap.thinking;
  renderMode();
  renderStats();
  renderQueue(snap.queue);
  renderRecent();
  loadSessions();
  $("#ws-recent").classList.add("hidden");
  $<HTMLTextAreaElement>("#input").focus();
}

function refreshTitle() {
  const snap = S.snap!;
  const u = S.items.find((i) => i.msg.role === "user");
  const t = snap.title || (u ? textOf(u.msg.content).slice(0, 50) : "新对话");
  $("#title").textContent = t;
  document.title = `${t} — StepHarness`;
}
function renderMode() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#mode button")) b.classList.toggle("on", b.dataset.mode === S.snap!.approvalMode);
  const sb = $("#sandbox-pill"), snap = S.snap!;
  sb.classList.toggle("off", !snap.sandbox);
  sb.textContent = snap.sandbox ? "沙箱" : "无沙箱";
  sb.title = !snap.sandboxAvailable ? "当前系统不支持命令沙箱"
    : snap.sandbox ? "命令沙箱已开启：命令只能写工作区和临时目录，不能访问外网、读不到凭据文件。点击关闭"
    : "命令沙箱已关闭：命令以你的完整权限运行。点击开启";
  const auto = document.querySelector<HTMLButtonElement>('#mode [data-mode="auto-edit"]')!;
  auto.title = snap.sandbox ? "工作区内的文件修改自动执行；命令在沙箱中自动运行；需要在沙箱外运行时询问" : "工作区内的文件修改自动执行；命令需要询问（只读命令除外）";
  const full = document.querySelector<HTMLButtonElement>('#mode [data-mode="full-auto"]')!;
  full.title = snap.sandbox ? "全部自动执行，不再询问（命令仍在沙箱中；申请在沙箱外运行时仍会询问）" : "全部自动执行，不再询问（没有沙箱保护）";
}
function renderStats() {
  const s = S.snap!.stats;
  const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const pct = s.contextWindow ? (s.contextTokens / s.contextWindow) * 100 : 0;
  $("#ctx").textContent = s.contextTokens ? `上下文 ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% · ${k(s.contextTokens)} · $${s.cost.toFixed(3)}` : "";
  $("#ctx").title = `输入 ${k(s.input)} · 输出 ${k(s.output)} · 缓存读 ${k(s.cacheRead)} · 缓存写 ${k(s.cacheWrite)}\n工具调用 ${s.toolCalls} 次 · 累计 $${s.cost.toFixed(4)}\n点击手动压缩上下文`;
}
function renderQueue(pending: string[]) {
  const q = $("#queue");
  q.classList.toggle("hidden", !pending.length);
  q.innerHTML = pending.map((t) => `<div>⏳ 排队中：${esc(t)}</div>`).join("");
}
function renderRecent() {
  const box = $("#ws-recent"), snap = S.snap!;
  const list = snap.recentCwds.filter((c) => c !== snap.cwd);
  box.innerHTML = list.map((c) => `<button data-cwd="${esc(c)}" title="${esc(c)}">${esc(c.startsWith(snap.home) ? "~" + c.slice(snap.home.length) : c)}</button>`).join("") + `<button data-choose>选择其他文件夹…</button>`;
}
async function loadSessions() {
  S.sessions = await call("listSessions");
  const ul = $("#session-list"), cur = S.snap?.sessionFile;
  $("#session-count").textContent = S.sessions.length ? String(S.sessions.length) : "";
  ul.innerHTML = S.sessions.length ? S.sessions.map((s) => `<li data-path="${esc(s.path)}" class="${s.path === cur ? "active" : ""}"><span class="t">${esc(s.title)}</span><span class="m">${ago(s.updated)}</span><button class="del" title="删除">✕</button></li>`).join("")
    : `<li class="empty-li">这个工作区还没有会话</li>`;
}
function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "刚刚"; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`; return new Date(t).toLocaleDateString();
}

function setBusy(b: boolean) {
  S.busy = b;
  $("#btn-stop").classList.toggle("hidden", !b);
  input.placeholder = b ? "运行中：继续输入可以插话（当前步骤完成后送达），Esc 停止" : "描述任务，⏎ 发送，⇧⏎ 换行；可以粘贴或拖入图片";
  working(); updateSend();
}
function setStatus(t: string) { $("#status").textContent = t; }
function toast(msg: string, kind = "info") {
  const el = document.createElement("div"); el.className = `toast ${kind}`; el.textContent = msg;
  $("#toasts").appendChild(el); setTimeout(() => el.remove(), kind === "error" ? 9000 : 3500);
}
const guard = async <T>(p: Promise<T>): Promise<T | undefined> => { try { return await p; } catch (e) { toast(String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "error"); return undefined; } };
const idle = () => { if (S.busy) { toast("正在运行中，请先停止"); return false; } return true; };

// ======================= 输入与发送 =======================
const input = $<HTMLTextAreaElement>("#input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.38) + "px"; }
function updateSend() { $<HTMLButtonElement>("#btn-send").disabled = !input.value.trim() && !S.attachments.length; }

async function sendPrompt() {
  const text = input.value;
  const images = S.attachments.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  if (!text.trim() && !images.length) return;
  if (!S.snap!.modelKey) { openProviderEditor(); return; }
  if (images.length && !S.snap!.model.input.includes("image")) return toast(`${S.snap!.model.id} 不支持图片输入，请换一个模型或移除图片`, "error");
  const saved = S.attachments;
  input.value = ""; S.attachments = []; renderAttachments(); autosize(); updateSend();
  const r = await guard(call("prompt", text, images));
  if (r === undefined) { input.value = text; S.attachments = saved; renderAttachments(); autosize(); updateSend(); }
}

function addFiles(files: File[]) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) { toast(`只能添加图片：${f.name}`); continue; }
    if (f.size > 5 * 1024 * 1024) { toast(`图片太大（上限 5MB）：${f.name}`, "error"); continue; }
    const r = new FileReader();
    r.onload = () => { const url = r.result as string; S.attachments.push({ data: url.slice(url.indexOf(",") + 1), mimeType: f.type, url }); renderAttachments(); updateSend(); };
    r.readAsDataURL(f);
  }
}
function renderAttachments() {
  const box = $("#attachments"); box.innerHTML = "";
  S.attachments.forEach((a, i) => {
    const d = document.createElement("div"); d.className = "att"; d.innerHTML = `<img src="${a.url}" /><button>✕</button>`;
    $("button", d).onclick = () => { S.attachments.splice(i, 1); renderAttachments(); updateSend(); };
    box.appendChild(d);
  });
}

input.addEventListener("input", () => { autosize(); updateSend(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.metaKey) { e.preventDefault(); sendPrompt(); } });
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$("#file").addEventListener("change", (e) => { const t = e.target as HTMLInputElement; addFiles([...(t.files || [])]); t.value = ""; });
$("#btn-send").onclick = sendPrompt;
$("#btn-stop").onclick = () => call("abort");
$(".suggestions").onclick = (e) => { const b = (e.target as HTMLElement).closest("button"); if (b) { input.value = b.textContent || ""; autosize(); updateSend(); input.focus(); } };

let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; $("#drop").classList.remove("hidden"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").classList.add("hidden"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#drop").classList.add("hidden"); addFiles([...(e.dataTransfer?.files || [])]); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#modal").classList.contains("hidden")) return closeModal();
    if (!$("#model-pop").classList.contains("hidden")) return $("#model-pop").classList.add("hidden");
    if (S.busy) { e.preventDefault(); call("abort"); }
  }
  if (e.key === "Enter" && e.metaKey && S.approvals.size) { e.preventDefault(); const first = [...S.approvals.values()][0]; call("approve", first.id, { decision: "allow" }); }
});

// ======================= 对话区交互 =======================
messagesEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) { navigator.clipboard.writeText(copy.closest("pre")!.querySelector("code")!.textContent || ""); copy.textContent = "已复制"; setTimeout(() => (copy.textContent = "复制"), 1200); return; }
  const a = t.closest("a"); if (a) { e.preventDefault(); call("openExternal", (a as HTMLAnchorElement).href); return; }
  const img = t.closest("img"); if (img) { showModal(`<img class="full" src="${(img as HTMLImageElement).src}" />`); return; }
  const ap = t.closest<HTMLElement>(".approval");
  if (ap) {
    const btn = t.closest<HTMLButtonElement>("button[data-d]");
    if (btn) call("approve", ap.dataset.approval, { decision: btn.dataset.d, feedback: btn.dataset.d === "deny" ? $<HTMLInputElement>("input", ap).value : undefined });
    return;
  }
  const pathEl = t.closest<HTMLElement>("[data-path]"); if (pathEl) { call("revealPath", pathEl.dataset.path); return; }
  const head = t.closest(".tool-head");
  if (head) {
    const card = head.parentElement as HTMLElement, id = card.dataset.tool!;
    S.open.set(id, !card.querySelector(".tool-body"));
    updateTool(id);
  }
});
messagesEl.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (e.key === "Enter" && t.matches(".approval input")) {
    e.preventDefault(); e.stopPropagation();
    const ap = t.closest<HTMLElement>(".approval")!, v = (t as HTMLInputElement).value.trim();
    if (v) call("approve", ap.dataset.approval, { decision: "deny", feedback: v });
  }
});

// ======================= 侧栏 / 顶栏交互 =======================
async function newSession() { if (idle()) await guard(call("newSession")); }
async function chooseWorkspace() { if (idle()) await guard(call("chooseWorkspace")); }
$("#btn-new").onclick = newSession;
$("#ws-btn").onclick = () => { if (S.snap!.recentCwds.filter((c) => c !== S.snap!.cwd).length) $("#ws-recent").classList.toggle("hidden"); else chooseWorkspace(); };
$("#ws-recent").onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button"); if (!b) return;
  if ("choose" in b.dataset) chooseWorkspace(); else if (idle()) guard(call("openWorkspace", b.dataset.cwd));
};
$("#session-list").onclick = async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-path]"); if (!li) return;
  const file = li.dataset.path!;
  if ((e.target as HTMLElement).closest(".del")) {
    if (file === S.snap!.sessionFile && !idle()) return;
    if (confirm("删除这个会话？此操作不可恢复。")) { await guard(call("deleteSession", file)); loadSessions(); }
    return;
  }
  if (file !== S.snap!.sessionFile && idle()) guard(call("openSession", file));
};
$("#title").ondblclick = () => {
  const el = $("#title"), cur = S.snap!.title || el.textContent || "";
  el.innerHTML = `<input value="${esc(cur)}" />`;
  const inp = $<HTMLInputElement>("input", el); inp.focus(); inp.select();
  const done = (save: boolean) => { const v = inp.value.trim(); if (save && v && v !== cur) call("setTitle", v); else refreshTitle(); };
  inp.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") { e.stopPropagation(); done(false); } };
  inp.onblur = () => done(true);
};
$("#sandbox-pill").onclick = async () => {
  const snap = S.snap!;
  if (!snap.sandboxAvailable) return toast("当前系统不支持命令沙箱");
  if (snap.sandbox && !confirm("关闭沙箱后，命令将以你的完整权限运行（可以联网、修改任意文件）。确定关闭吗？")) return;
  snap.sandbox = await call("setSandbox", !snap.sandbox);
  renderMode();
  toast(snap.sandbox ? "命令沙箱已开启" : "命令沙箱已关闭");
};
$("#ctx").onclick = async () => {
  if (!idle() || S.snap!.compacting) return;
  if (!S.items.some((i) => i.msg.role === "assistant")) return toast("还没有可以压缩的内容");
  if (!confirm("把之前的对话总结成摘要，以节省上下文？")) return;
  await guard(call("compact"));
};
$("#thinking").onchange = (e) => { const v = (e.target as HTMLSelectElement).value as ThinkingLevel; S.snap!.thinking = v; call("setThinking", v); };
$("#mode").onclick = (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]"); if (!b) return;
  const mode = b.dataset.mode as ApprovalMode;
  if (mode === "full-auto" && S.snap!.approvalMode !== "full-auto" && !confirm("全自动模式下，StepHarness 会直接执行任何命令和文件修改，不再询问。确定开启吗？")) return;
  S.snap!.approvalMode = mode; renderMode(); call("setApprovalMode", mode);
};

// 模型选择（按服务分组）
let modelSel = 0, modelShown: ModelRow[] = [];
function renderModels() {
  const q = $<HTMLInputElement>("#model-search").value.trim().toLowerCase();
  const cur = S.snap!.modelKey;
  modelShown = S.models.filter((m) => !q || m.key.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q)).slice(0, 300);
  modelSel = Math.min(modelSel, Math.max(0, modelShown.length - 1));
  let html = "", group = "";
  modelShown.forEach((m, i) => {
    if (m.providerName !== group) { group = m.providerName; html += `<div class="pop-group">${esc(group)}</div>`; }
    html += `<div class="pop-item${i === modelSel ? " sel" : ""}" data-key="${esc(m.key)}"><span class="n">${esc(m.id)}</span>${m.input.includes("image") ? `<span class="tag">图片</span>` : ""}${m.key === cur ? `<span class="cur">✓</span>` : ""}</div>`;
  });
  if (!S.models.length) html = `<div class="pop-group">还没有配置模型服务</div>`;
  else if (!modelShown.length) html = `<div class="pop-group">没有匹配的模型</div>`;
  $("#model-items").innerHTML = html + `<div class="pop-item manage" data-manage="1"><span class="n">管理模型服务…</span></div>`;
  $("#model-items .sel")?.scrollIntoView({ block: "nearest" });
}
function applyModel(model: ModelInfo, key: string) {
  S.snap!.model = model; S.snap!.modelKey = key;
  $("#model-name").textContent = key ? model.id : "未配置模型";
  $("#model-btn").title = key ? `${key}（${API_LABEL[model.api] ?? model.api}）` : "点击添加模型服务";
  $<HTMLSelectElement>("#thinking").disabled = !model.reasoning;
  S.snap!.stats.contextWindow = model.contextWindow; renderStats();
  renderEmpty();
}
async function pickModel(key: string) {
  $("#model-pop").classList.add("hidden");
  const r = await guard(call("setModel", key));
  if (r) applyModel(r.model, r.modelKey);
  input.focus();
}
$("#model-btn").onclick = async (e) => {
  e.stopPropagation();
  if (!S.snap!.modelKey && !S.snap!.providerCount) return openProviderEditor();
  const pop = $("#model-pop");
  if (!pop.classList.toggle("hidden")) { S.models = await call("models"); $<HTMLInputElement>("#model-search").value = ""; modelSel = Math.max(0, S.models.findIndex((m) => m.key === S.snap!.modelKey)); renderModels(); $("#model-search").focus(); }
};
$("#model-search").oninput = () => { modelSel = 0; renderModels(); };
$("#model-search").onkeydown = (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); modelSel = Math.min(modelSel + 1, modelShown.length - 1); renderModels(); }
  if (e.key === "ArrowUp") { e.preventDefault(); modelSel = Math.max(modelSel - 1, 0); renderModels(); }
  if (e.key === "Enter" && modelShown[modelSel]) pickModel(modelShown[modelSel].key);
};
$("#model-pop").onclick = (e) => {
  e.stopPropagation();
  const it = (e.target as HTMLElement).closest<HTMLElement>(".pop-item"); if (!it) return;
  if (it.dataset.manage) { $("#model-pop").classList.add("hidden"); openSettings(); } else pickModel(it.dataset.key!);
};
document.addEventListener("click", () => $("#model-pop").classList.add("hidden"));

// 弹窗
function showModal(html: string) { $("#modal-card").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); $("#modal-card").innerHTML = ""; }
$("#modal").addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).id === "modal") closeModal(); });

// 设置：模型服务、沙箱、压缩
async function openSettings() {
  const [s, providers] = await Promise.all([call("getSettings"), call("providers") as Promise<ProviderView[]>]);
  const rows = providers.map((p) => `<div class="prov" data-id="${esc(p.id)}">
      <div class="prov-main"><b>${esc(p.name)}</b> <span class="muted mono small">${esc(p.id)}</span>
        <div class="muted small">${esc(API_LABEL[p.api] ?? p.api)} · ${esc(p.baseUrl)} · ${p.models.length} 个模型</div>
        <div class="small ${p.key.ok ? "ok" : "bad"}">${p.key.ok ? `🔑 Key：${esc(p.key.source)}` : "⚠ 还没有配置 API Key"}</div></div>
      <div class="prov-act"><button data-edit="${esc(p.id)}">编辑</button><button data-del="${esc(p.id)}" class="danger">删除</button></div></div>`).join("");
  showModal(`<h3>设置</h3>
    <div class="sec">模型服务</div>
    ${rows || `<div class="hint">还没有添加模型服务。添加后才能开始对话。</div>`}
    <div><button id="set-add" class="primary-sm">＋ 添加模型服务</button></div>
    <div class="hint">API Key 保存在${esc(s.secretStore)}，不会写入配置文件，也不会显示在界面上。</div>
    <div class="sec">安全</div>
    <label class="check"><input id="set-sandbox" type="checkbox" ${s.sandbox ? "checked" : ""} ${s.sandboxAvailable ? "" : "disabled"} /> 命令沙箱${s.sandboxAvailable ? "（推荐）：命令只能写工作区和临时目录，不能访问外网，读不到凭据文件" : "：当前系统不支持"}</label>
    <label>沙箱里额外允许写入的目录（每行一个，例如 ~/.cache/pip）<textarea id="set-roots" rows="2" spellcheck="false">${esc((s.writableRoots || []).join("\n"))}</textarea></label>
    <div class="sec">上下文</div>
    <label class="check"><input id="set-compact" type="checkbox" ${s.autoCompact ? "checked" : ""} /> 自动压缩：上下文用到 80% 时，把较早的对话总结成摘要</label>
    <div class="hint">数据目录 ${esc(s.dataDir)} · 项目根目录下的 AGENTS.md 会自动作为项目说明加载</div>
    <div class="row"><button id="set-cancel">关闭</button><button id="set-save" class="primary">保存</button></div>`);
  $("#set-cancel").onclick = closeModal;
  $("#set-add").onclick = () => openProviderEditor();
  $("#modal-card").addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const edit = t.closest<HTMLElement>("[data-edit]"), del = t.closest<HTMLElement>("[data-del]");
    if (edit) openProviderEditor(providers.find((p) => p.id === edit.dataset.edit));
    if (del && confirm(`删除服务「${del.dataset.del}」？保存的 API Key 也会一起删除。`)) { await guard(call("removeProvider", del.dataset.del)); openSettings(); }
  });
  $("#set-save").onclick = async () => {
    const roots = $<HTMLTextAreaElement>("#set-roots").value.split("\n").map((x) => x.trim()).filter(Boolean);
    await guard(call("saveSettings", { writableRoots: roots }));
    const sb = $<HTMLInputElement>("#set-sandbox").checked, ac = $<HTMLInputElement>("#set-compact").checked;
    if (sb !== S.snap!.sandbox && s.sandboxAvailable) S.snap!.sandbox = await call("setSandbox", sb);
    if (ac !== S.snap!.autoCompact) { await call("setAutoCompact", ac); S.snap!.autoCompact = ac; }
    renderMode(); closeModal(); toast("设置已保存");
  };
}
$("#btn-settings").onclick = openSettings;

/** 添加或编辑模型服务。Key 只会发给主进程保存，界面拿不回来 */
async function openProviderEditor(existing?: ProviderView) {
  const presets: Preset[] = await call("presets");
  const isNew = !existing;
  const p = existing ?? { id: "", name: "", api: "openai-completions", baseUrl: "", apiKeyEnv: "", models: [], key: { source: "未配置", ok: false } };
  showModal(`<h3>${isNew ? "添加模型服务" : `编辑「${esc(p.name)}」`}</h3>
    ${isNew ? `<label>从预设开始<select id="pv-preset"><option value="">（选择一个常见服务，或手动填写）</option>${presets.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>` : ""}
    <div class="grid2">
      <label>名称<input id="pv-name" value="${esc(p.name)}" placeholder="例如：我的 DeepSeek" /></label>
      <label>服务 ID<input id="pv-id" value="${esc(p.id)}" placeholder="小写字母、数字、短横线" ${isNew ? "" : "disabled"} spellcheck="false" /></label>
    </div>
    <label>API 类型<select id="pv-api">${Object.entries(API_LABEL).map(([k, v]) => `<option value="${k}" ${p.api === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label>服务地址<input id="pv-base" value="${esc(p.baseUrl)}" placeholder="https://…" spellcheck="false" /><span id="pv-note" class="hint"></span></label>
    <label>API Key<input id="pv-key" type="password" autocomplete="off" placeholder="${p.key.ok ? `已配置（${esc(p.key.source)}），留空表示不修改` : "粘贴你的 API Key"}" />
      ${!isNew && p.key.ok && !/环境变量/.test(p.key.source) ? `<a href="#" id="pv-clear" class="small">删除已保存的 Key</a>` : ""}</label>
    <label>或者从环境变量读取（可选，只有填写了才会读取）<input id="pv-env" value="${esc(p.apiKeyEnv ?? "")}" placeholder="例如 DEEPSEEK_API_KEY" spellcheck="false" /></label>
    <label>模型（每行一个模型 ID）<textarea id="pv-models" rows="5" spellcheck="false" placeholder="点击下方「从服务获取」，或手动填写">${esc(p.models.map((m) => m.id).join("\n"))}</textarea></label>
    <div class="row left"><button id="pv-fetch">从服务获取模型列表</button><span id="pv-status" class="small muted"></span></div>
    <div class="row"><button id="pv-cancel">取消</button><button id="pv-save" class="primary">保存</button></div>`);
  const v = (id: string) => $<HTMLInputElement>(id).value.trim();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const form = (): any => {
    const ids = $<HTMLTextAreaElement>("#pv-models").value.split("\n").map((x) => x.trim()).filter(Boolean);
    const old = new Map(p.models.map((m) => [m.id, m]));
    return { id: isNew ? v("#pv-id") : p.id, name: v("#pv-name"), api: v("#pv-api"), baseUrl: v("#pv-base"), apiKeyEnv: v("#pv-env") || undefined, headers: p.headers, models: ids.map((id) => old.get(id) ?? { id }) };
  };
  if (isNew) {
    $("#pv-preset").onchange = () => {
      const x = presets.find((y) => y.id === v("#pv-preset")); if (!x) return;
      const taken = new Set<string>();
      $<HTMLInputElement>("#pv-name").value = x.name; $<HTMLInputElement>("#pv-id").value = x.id.startsWith("custom") ? "" : x.id;
      $<HTMLSelectElement>("#pv-api").value = x.api; $<HTMLInputElement>("#pv-base").value = x.baseUrl;
      $<HTMLInputElement>("#pv-env").placeholder = x.apiKeyEnv ? `例如 ${x.apiKeyEnv}` : "例如 MY_API_KEY";
      $("#pv-note").textContent = x.note ?? ""; void taken;
      (x.baseUrl ? $("#pv-key") : $("#pv-base")).focus();
    };
    $("#pv-name").addEventListener("input", () => { if (!$<HTMLInputElement>("#pv-id").dataset.touched) $<HTMLInputElement>("#pv-id").value = slug(v("#pv-name")); });
    $("#pv-id").addEventListener("input", () => { $<HTMLInputElement>("#pv-id").dataset.touched = "1"; });
  }
  $("#pv-clear")?.addEventListener("click", async (e) => { e.preventDefault(); if (confirm("删除已保存的 API Key？")) { await guard(call("clearProviderKey", p.id)); toast("已删除"); openProviderEditor({ ...p, key: { source: "未配置", ok: false } }); } });
  $("#pv-cancel").onclick = () => (S.snap!.providerCount ? openSettings() : closeModal());
  $("#pv-fetch").onclick = async () => {
    const st = $("#pv-status"); st.textContent = "正在获取…"; st.className = "small muted";
    try {
      const ids: string[] = await call("fetchModels", form(), v("#pv-key") || undefined);
      if (!ids.length) { st.textContent = "服务没有返回任何模型，请手动填写"; return; }
      const box = $<HTMLTextAreaElement>("#pv-models");
      const cur = new Set(box.value.split("\n").map((x) => x.trim()).filter(Boolean));
      if (!cur.size) box.value = ids.join("\n");
      st.textContent = cur.size ? `连接成功，服务提供 ${ids.length} 个模型（已保留你填写的列表）` : `连接成功，获取到 ${ids.length} 个模型。可以删掉不需要的`;
      st.className = "small ok";
    } catch (err) { st.textContent = String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); st.className = "small bad"; }
  };
  $("#pv-save").onclick = async () => {
    const data = form();
    if (!data.models.length && !confirm("还没有填写任何模型，仍然保存吗？")) return;
    const saved = await guard(call("saveProvider", data, { isNew, apiKey: v("#pv-key") || undefined }));
    if (!saved) return;
    toast(`已保存「${saved.name}」${saved.key.ok ? "" : "，但还没有配置 API Key"}`);
    S.models = [];
    openSettings();
  };
  (isNew ? $("#pv-preset") : $("#pv-key")).focus();
}

/** 没有配置模型时，空白页给出引导 */
function renderEmpty() {
  const need = !S.snap?.modelKey;
  $("#onboard").classList.toggle("hidden", !need);
  $(".suggestions").classList.toggle("hidden", need);
}
$("#onboard-btn").onclick = () => openProviderEditor();

// ======================= 启动 =======================
window.stepharness.onEvent(onEvent);
(async () => {
  applySnapshot(await call("snapshot"));
  autosize(); updateSend();
})();
