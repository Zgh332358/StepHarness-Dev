// Agent 离线测试：用脚本化的假模型驱动真实的 Agent 循环、工具、沙箱和压缩逻辑，不联网、不需要 API Key。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, type AgentEvent } from "../src/core/agent.js";
import { COMPACTION_SYSTEM, chooseCut, contextEstimate, estimateTokens, isOverflowError } from "../src/core/compaction.js";
import { sandboxAvailable } from "../src/core/sandbox.js";
import { SessionStore } from "../src/core/session.js";
import { emptyUsage, ProviderError, type AssistantMessage, type Message, type ModelInfo, type ProviderRequest, type ToolResultMessage } from "../src/core/types.js";
import { describe, eq, expect, test } from "./harness.js";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "fake", name: "假模型", api: "anthropic-messages", provider: "test", baseUrl: "http://127.0.0.1:9", reasoning: false,
  input: ["text", "image"], contextWindow: 200000, maxTokens: 8000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, ...over,
});
const reply = (content: AssistantMessage["content"], usage = 100): AssistantMessage => ({
  role: "assistant", content, api: "anthropic-messages", model: "fake", stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
  usage: { ...emptyUsage(), input: usage, output: usage ? 10 : 0, cost: usage ? 0.001 : 0 }, timestamp: Date.now(),
});
const say = (t: string, usage?: number) => reply([{ type: "text", text: t }], usage);
let callSeq = 0;
const call = (name: string, args: Record<string, unknown>) => reply([{ type: "toolCall", id: `call_${++callSeq}`, name, arguments: args }]);

/** 脚本化的假模型：按顺序返回；压缩请求单独处理 */
function fakeModel(script: ((req: ProviderRequest) => AssistantMessage | Promise<AssistantMessage>)[], opts: { summary?: string | Error } = {}) {
  const calls: ProviderRequest[] = [];
  const compactions: ProviderRequest[] = [];
  let i = 0;
  const stream = async (req: ProviderRequest): Promise<AssistantMessage> => {
    if (req.system === COMPACTION_SYSTEM) {
      compactions.push(req);
      if (opts.summary instanceof Error) throw opts.summary;
      return say(opts.summary ?? "摘要：用户在做一个测试项目，已经完成了第一阶段。");
    }
    calls.push(req);
    const step = script[Math.min(i++, script.length - 1)];
    const msg = await step(req);
    // 像真实模型一样，按请求大小报告输入用量
    msg.usage = { ...msg.usage, input: 3000 + req.messages.reduce((n, m) => n + estimateTokens(m), 0) };
    return msg;
  };
  return { stream, calls, compactions };
}

function setup(opts: { files?: Record<string, string>; mode?: "ask" | "auto-edit" | "full-auto"; sandbox?: boolean; model?: ModelInfo; stream: any; messages?: Message[]; onApproval?: (e: any, a: Agent) => void }) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-agent-")));
  for (const [f, c] of Object.entries(opts.files ?? {})) fs.writeFileSync(path.join(cwd, f), c);
  const agent = new Agent({ cwd, model: opts.model ?? model(), getApiKey: () => "test-key", approvalMode: opts.mode ?? "auto-edit", sandbox: opts.sandbox ?? true, stream: opts.stream, messages: opts.messages, retryBaseMs: 1 });
  const events: AgentEvent[] = [];
  agent.on((e) => { events.push(e); if (e.type === "approval_request") (opts.onApproval ?? ((r, a) => a.respondApproval(r.id, { decision: "allow" })))(e.request, agent); });
  const run = async (text: string) => {
    const done = new Promise<any>((r) => { const off = agent.on((e) => { if (e.type === "agent_end") { off(); r(e); } }); });
    await agent.prompt(text);
    return done;
  };
  return { cwd, agent, events, run };
}
const results = (a: Agent) => a.messages.filter((m) => m.role === "toolResult") as ToolResultMessage[];
const H = os.homedir();

describe("Agent 循环（假模型）", () => {
  test("调用工具 → 拿到结果 → 给出回答", async () => {
    const f = fakeModel([() => call("bash", { command: "echo 你好" }), () => say("命令输出了你好")]);
    const { agent, run } = setup({ stream: f.stream, sandbox: false, mode: "full-auto" });
    eq((await run("执行 echo")).reason, "done");
    expect(results(agent)[0].content.some((b: any) => b.text?.includes("你好")));
    eq(f.calls.length, 2);
    // 第二次调用模型时，历史里要带上工具结果
    expect(f.calls[1].messages.some((m) => m.role === "toolResult"));
  });
  test("模型返回的工具参数不是合法 JSON 时，提示模型重新生成而不是崩溃", async () => {
    const f = fakeModel([() => call("bash", { _raw: "{bad json" }), () => say("好的")]);
    const { agent, run } = setup({ stream: f.stream, mode: "full-auto" });
    eq((await run("x")).reason, "done");
    expect(results(agent)[0].isError);
  });
  test("调用不存在的工具时返回错误结果", async () => {
    const f = fakeModel([() => call("delete_everything", {}), () => say("好的")]);
    const { agent, run } = setup({ stream: f.stream, mode: "full-auto" });
    eq((await run("x")).reason, "done");
    expect(/未知工具/.test((results(agent)[0].content[0] as any).text));
  });
});

describe("沙箱与审批（假模型 + 真实沙箱）", () => {
  if (!sandboxAvailable()) { test("当前系统不支持沙箱，跳过", () => {}); return; }
  test("自动编辑 + 沙箱：命令自动在沙箱里运行，写工作区外会失败并提示可以申请", async () => {
    const target = path.join(H, `stepharness-agent-sbx-${Date.now()}`);
    const f = fakeModel([() => call("bash", { command: `touch ${target}` }), () => say("失败了")]);
    const { agent, events, run } = setup({ stream: f.stream, mode: "auto-edit", sandbox: true });
    await run("x");
    expect(!events.some((e) => e.type === "approval_request"), "沙箱内命令不应该询问");
    expect(!fs.existsSync(target), "沙箱没有拦住写家目录");
    const r = results(agent)[0];
    expect((r.details as any).sandboxed === true && /unsandboxed/.test((r.content[0] as any).text), "失败结果里没有提示如何申请");
  });
  test("工作区内的命令在沙箱里正常运行", async () => {
    const f = fakeModel([() => call("bash", { command: "echo 内容 > out.txt && cat out.txt" }), () => say("好")]);
    const { cwd, agent, run } = setup({ stream: f.stream, mode: "auto-edit" });
    await run("x");
    eq(fs.readFileSync(path.join(cwd, "out.txt"), "utf8"), "内容\n");
    expect(!results(agent)[0].isError);
  });
  test("申请在沙箱外运行：必须审批，理由会展示给用户；拒绝则不执行", async () => {
    const target = path.join(H, `stepharness-agent-unsbx-${Date.now()}`);
    let reason = "";
    const f = fakeModel([() => call("bash", { command: `touch ${target}`, unsandboxed: true, justification: "需要在家目录创建文件" }), () => say("好")]);
    const { run } = setup({ stream: f.stream, mode: "auto-edit", onApproval: (r, a) => { reason = r.reason; a.respondApproval(r.id, { decision: "deny" }); } });
    eq((await run("x")).reason, "denied");
    expect(reason.includes("沙箱外") && reason.includes("需要在家目录创建文件"), `理由：${reason}`);
    expect(!fs.existsSync(target));
  });
  test("全自动模式下，申请在沙箱外运行仍然需要审批", async () => {
    let asked = false;
    const f = fakeModel([() => call("bash", { command: "echo hi", unsandboxed: true, justification: "测试" }), () => say("好")]);
    const { run } = setup({ stream: f.stream, mode: "full-auto", onApproval: (r, a) => { asked = true; a.respondApproval(r.id, { decision: "allow" }); } });
    await run("x");
    expect(asked);
  });
  test("批准在沙箱外运行后，命令确实不受沙箱限制", async () => {
    const target = path.join(os.tmpdir(), `..`, `stepharness-unsbx-ok-${Date.now()}`); // /private/var/folders/xx 之外
    const f = fakeModel([() => call("bash", { command: `echo ok && curl -s -m 1 http://example.invalid >/dev/null; echo net-tried`, unsandboxed: true, justification: "联网" }), () => say("好")]);
    const { agent, run } = setup({ stream: f.stream, mode: "auto-edit" });
    await run("x");
    eq((results(agent)[0].details as any).sandboxed, false);
    void target;
  });
  test("询问模式 + 沙箱：非只读命令仍然询问", async () => {
    let asked = 0;
    const f = fakeModel([() => call("bash", { command: "touch a.txt" }), () => say("好")]);
    const { run } = setup({ stream: f.stream, mode: "ask", onApproval: (r, a) => { asked++; a.respondApproval(r.id, { decision: "allow" }); } });
    await run("x");
    eq(asked, 1);
  });
  test("关闭沙箱时保持原来的行为：自动编辑模式下命令需要询问", async () => {
    let asked = 0;
    const f = fakeModel([() => call("bash", { command: "touch a.txt" }), () => say("好")]);
    const { agent, run } = setup({ stream: f.stream, mode: "auto-edit", sandbox: false, onApproval: (r, a) => { asked++; a.respondApproval(r.id, { decision: "allow" }); } });
    await run("x");
    eq(asked, 1);
    eq((results(agent)[0].details as any).sandboxed, false);
  });
  test("系统提示词告诉模型沙箱状态", async () => {
    const f = fakeModel([() => say("好")]);
    const { run } = setup({ stream: f.stream, sandbox: true });
    await run("x");
    expect(/命令沙箱：开启/.test(f.calls[0].system));
  });
});

describe("上下文压缩（假模型）", () => {
  const big = (n: number) => "很长的工具输出内容。".repeat(n);
  /** 构造一段已有的长历史：每轮 用户 → 调用工具 → 工具结果 → 回答 */
  function history(turns: number, size: number): Message[] {
    const out: Message[] = [];
    for (let t = 0; t < turns; t++) {
      const id = `h${t}`;
      out.push({ role: "user", content: [{ type: "text", text: `第 ${t + 1} 个任务` }], timestamp: 0 });
      out.push(reply([{ type: "toolCall", id, name: "read", arguments: { path: `f${t}.txt` } }], 0));
      out.push({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: big(size) }], isError: false, timestamp: 0 });
      out.push(say(`第 ${t + 1} 个任务完成`, 0));
    }
    return out;
  }

  test("超过阈值时自动压缩：旧消息变成摘要，最近几轮保留原文", async () => {
    const m = model({ contextWindow: 20000, maxTokens: 2000 });
    const f = fakeModel([() => say("继续完成了")], { summary: "这是摘要" });
    const { agent, events, run } = setup({ stream: f.stream, model: m, messages: history(12, 400) });
    const before = contextEstimate(agent.messages);
    eq((await run("继续")).reason, "done");
    eq(f.compactions.length, 1, "应该压缩一次");
    const end = events.find((e) => e.type === "compaction_end") as any;
    expect(end?.ok && end.reason === "threshold", "没有 compaction_end 事件");
    expect(agent.messages[0].role === "user" && !!(agent.messages[0] as any).compaction, "第一条不是摘要");
    expect(contextEstimate(agent.messages) < before / 2, `压缩后没有明显变小：${before} → ${contextEstimate(agent.messages)}`);
    // 发给模型的请求里是摘要而不是旧消息
    expect(f.calls[0].messages.some((x) => x.role === "user" && (x.content[0] as any).text.includes("这是摘要")));
    expect(!f.calls[0].messages.some((x) => x.role === "user" && (x.content[0] as any).text === "第 1 个任务"), "旧消息仍在上下文中");
  });

  test("压缩后保留的部分里，每个工具结果都能找到对应的调用", async () => {
    const m = model({ contextWindow: 20000, maxTokens: 2000 });
    const f = fakeModel([() => say("好")]);
    const { agent, run } = setup({ stream: f.stream, model: m, messages: history(12, 400) });
    await run("继续");
    const callIds = new Set(agent.messages.flatMap((x) => x.role === "assistant" ? x.content.filter((b) => b.type === "toolCall").map((b: any) => b.id) : []));
    for (const r of results(agent)) expect(callIds.has(r.toolCallId), `孤立的工具结果 ${r.toolCallId}`);
  });

  test("界面记录保留全部旧消息，并追加一条摘要", async () => {
    const m = model({ contextWindow: 20000, maxTokens: 2000 });
    const f = fakeModel([() => say("好")]);
    const hist = history(12, 400);
    const { agent, run } = setup({ stream: f.stream, model: m, messages: hist });
    await run("继续");
    expect(agent.display.length > agent.messages.length);
    expect(agent.display.some((x) => x.role === "user" && (x.content[0] as any).text === "第 1 个任务"));
    eq(agent.display.filter((x: any) => x.compaction).length, 1);
  });

  test("会话重新加载后：上下文是压缩后的，界面记录是完整的", async () => {
    const m = model({ contextWindow: 20000, maxTokens: 2000 });
    const f = fakeModel([() => say("好")]);
    const { agent, run } = setup({ stream: f.stream, model: m });
    // 先通过真实流程写入会话，再压缩
    for (let i = 0; i < 4; i++) await run(`任务 ${i} ` + big(1200));
    expect(f.compactions.length >= 1, "没有触发压缩");
    const { messages, display } = SessionStore.load(agent.session.file);
    eq(messages.length, agent.messages.length, "重新加载的上下文与内存不一致");
    expect(!!(messages[0] as any).compaction);
    eq(display.length, agent.display.length);
  });

  test("模型报告上下文超长：压缩后自动重试，错误不会留在历史里", async () => {
    let n = 0;
    const f = fakeModel([
      () => { n++; throw new ProviderError("HTTP 400：prompt is too long: 250000 tokens > 200000 maximum", 400, false); },
      () => { n++; return say("压缩后成功了"); },
    ]);
    const { agent, events, run } = setup({ stream: f.stream, messages: history(6, 50) });
    eq((await run("继续")).reason, "done");
    eq(n, 2);
    expect((events.find((e) => e.type === "compaction_end") as any)?.reason === "overflow");
    expect(!agent.messages.some((x) => x.role === "assistant" && x.stopReason === "error"), "超长错误留在了历史里");
  });

  test("压缩后仍然超长：只重试一次，然后报错结束", async () => {
    const f = fakeModel([() => { throw new ProviderError("HTTP 400：prompt is too long", 400, false); }]);
    const { run } = setup({ stream: f.stream, messages: history(6, 50) });
    const end = await run("继续");
    eq(end.reason, "error");
    eq(f.compactions.length, 1);
  });

  test("生成摘要失败：上下文保持不变，任务继续", async () => {
    const m = model({ contextWindow: 20000, maxTokens: 2000 });
    const f = fakeModel([() => say("好")], { summary: new Error("网关错误") });
    const hist = history(12, 400);
    const { agent, events, run } = setup({ stream: f.stream, model: m, messages: hist });
    const n = hist.length;
    eq((await run("继续")).reason, "done");
    expect((events.find((e) => e.type === "compaction_end") as any)?.ok === false);
    eq(agent.messages.length, n + 2, "失败后上下文被改动了");
  });

  test("实际用量超限但按文字估算很小时：在最近一条用户消息前切分，保留最新请求原文", async () => {
    const m = model({ contextWindow: 100000, maxTokens: 2000 });
    let first = true;
    const f = fakeModel([() => { const r = say("好"); return r; }]);
    // 用一个报告超大用量的模型回复作为历史结尾（模拟图片、代码等估算偏小的情况）
    const hist: Message[] = [
      { role: "user", content: [{ type: "text", text: "旧任务" }], timestamp: 0 },
      { ...say("旧回答"), usage: { ...emptyUsage(), input: 95000, output: 10 } },
    ];
    const { agent, run } = setup({ stream: f.stream, model: m, messages: hist });
    void first;
    await run("最新的请求原文");
    eq(f.compactions.length, 1);
    const ctx = f.calls[0].messages;
    expect(ctx.some((x) => x.role === "user" && (x.content as any[]).some((b) => b.text === "最新的请求原文")), "最新请求没有原样保留");
    expect(!ctx.some((x) => x.role === "user" && (x.content as any[]).some((b) => b.text === "旧任务")), "旧任务没有被总结掉");
    void agent;
  });

  test("手动压缩", async () => {
    const f = fakeModel([() => say("好")]);
    const { agent } = setup({ stream: f.stream, messages: history(8, 100) });
    expect(await agent.compactNow());
    expect(!!(agent.messages[0] as any).compaction);
  });

  test("压缩调用的费用计入统计", async () => {
    const f = fakeModel([() => say("好")]);
    const { agent } = setup({ stream: f.stream, messages: history(8, 100) });
    const before = agent.stats().cost;
    await agent.compactNow();
    expect(agent.stats().cost > before);
  });

  test("运行中不能手动压缩", async () => {
    let release!: () => void;
    const f = fakeModel([() => new Promise((r) => { release = () => r(say("好")); })]);
    const { agent, run } = setup({ stream: f.stream });
    const p = run("x");
    await new Promise((r) => setTimeout(r, 20));
    let threw = false;
    try { await agent.compactNow(); } catch { threw = true; }
    release(); await p;
    expect(threw);
  });

  test("切分点总是落在用户消息上", () => {
    const h = history(10, 200);
    for (const budget of [100, 500, 1000, 3000, 10000]) {
      const cut = chooseCut(h, budget);
      expect(cut === h.length || h[cut].role === "user", `预算 ${budget} 时切在了 ${h[cut]?.role}`);
    }
  });

  test("识别各家模型的上下文超长错误", () => {
    for (const m of ["prompt is too long: 210000 tokens > 200000 maximum", "This model's maximum context length is 128000 tokens", "context_length_exceeded",
      "Input is too long for requested model", "Please reduce the length of the messages", "上下文长度超过限制"]) expect(isOverflowError(m), m);
    for (const m of ["Invalid API Key", "rate limit exceeded", "Internal server error"]) expect(!isOverflowError(m), m);
  });
});
