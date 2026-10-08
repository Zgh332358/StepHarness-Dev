#!/usr/bin/env node
// StepHarness 命令行：不依赖界面，直接驱动内核。
//   node dist/cli.mjs [--cwd 目录] [--model 服务/模型] [--thinking low] [--mode ask|auto-edit|full-auto] [--no-sandbox] "任务"
//   node dist/cli.mjs models                 列出已配置的模型
//   node dist/cli.mjs key set <服务ID>        保存 API Key（从终端隐藏输入或标准输入读取）
//   node dist/cli.mjs key clear <服务ID>      删除保存的 API Key
import readline from "node:readline";
import {
  Agent, apiKeySource, defaultModel, findModel, getProvider, listModels, listProviders, loadConfig, modelKey, resolveApiKey, secretStoreName, setSecret, deleteSecret,
  type AgentEvent, type ApprovalMode, type ThinkingLevel,
} from "./core/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name: string) => { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; };
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`, cyan = (s: string) => `\x1b[36m${s}\x1b[0m`, red = (s: string) => `\x1b[31m${s}\x1b[0m`, green = (s: string) => `\x1b[32m${s}\x1b[0m`;

/** 隐藏输入读取一行（不回显、不进 shell 历史）；非终端时从标准输入读取 */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => resolve(d.trim())); return; }
    process.stderr.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: undefined, terminal: true });
    (rl as any)._writeToOutput = () => {};
    rl.question("", (v) => { rl.close(); process.stderr.write("\n"); resolve(v.trim()); });
  });
}

async function keyCommand() {
  const [, action, id] = args;
  if (!id || !["set", "clear"].includes(action)) { console.error("用法：key set <服务ID> | key clear <服务ID>"); process.exit(1); }
  if (!getProvider(id)) { console.error(`没有 ID 为「${id}」的服务。已配置：${listProviders().map((p) => p.id).join("、") || "无"}`); process.exit(1); }
  if (action === "clear") { deleteSecret(id); console.error(green(`已删除「${id}」的 API Key`)); return; }
  const key = await readSecret(`输入「${id}」的 API Key（不会显示）：`);
  setSecret(id, key);
  console.error(green(`已保存到 ${secretStoreName()}`));
}

function modelsCommand() {
  const providers = listProviders();
  if (!providers.length) { console.error("还没有配置模型服务。请在 StepHarness 应用的「设置」里添加，或编辑 ~/.stepharness/config.json"); return; }
  const def = defaultModel();
  for (const p of providers) {
    const k = apiKeySource(p.id);
    console.log(`${p.name}（${p.id}，${p.api}）${k.ok ? dim(` Key：${k.source}`) : red(" 未配置 Key")}`);
    for (const m of p.models) console.log(`  ${def && modelKey(def) === `${p.id}/${m.id}` ? "*" : " "} ${p.id}/${m.id}`);
  }
}

async function run() {
  const cwd = flag("cwd") || process.cwd();
  const key = flag("model");
  const thinking = (flag("thinking") || "low") as ThinkingLevel;
  const mode = (flag("mode") || "auto-edit") as ApprovalMode;
  const sandbox = !bool("no-sandbox");
  const prompt = args.join(" ").trim();
  if (!prompt) { console.error("用法：node dist/cli.mjs [--cwd 目录] [--model 服务/模型] [--thinking off|low|medium|high] [--mode ask|auto-edit|full-auto] [--no-sandbox] \"任务\"\n      node dist/cli.mjs models | key set <服务ID>"); process.exit(1); }
  const model = key ? findModel(key) : defaultModel(loadConfig());
  if (!model) { console.error(key ? `找不到模型 ${key}，可以用 models 命令查看` : "还没有配置模型服务，请先在应用里添加"); process.exit(1); }

  const agent = new Agent({ cwd, model, thinking, approvalMode: mode, sandbox, getApiKey: (m) => resolveApiKey(m.provider) });
  console.error(dim(`模型 ${modelKey(model)}（${model.api}） · 思考 ${thinking} · 审批 ${mode} · 沙箱 ${agent.sandbox ? "开" : "关"} · ${cwd}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  let lastKind = "";
  const done = new Promise<Extract<AgentEvent, { type: "agent_end" }>>((resolve) => {
    agent.on(async (e) => {
      switch (e.type) {
        case "assistant_delta":
          if (e.event.type === "thinking_delta") { if (lastKind !== "thinking") process.stderr.write(dim("\n[思考] ")); process.stderr.write(dim(e.event.delta)); lastKind = "thinking"; }
          else if (e.event.type === "text_delta") { if (lastKind !== "text") process.stdout.write("\n"); process.stdout.write(e.event.delta); lastKind = "text"; }
          break;
        case "tool_start": lastKind = "tool"; process.stderr.write(cyan(`\n▶ ${e.name} ${JSON.stringify(e.args).slice(0, 200)}\n`)); break;
        case "message":
          if (e.message.role === "toolResult") {
            const lines = e.message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").split("\n");
            process.stderr.write((e.message.isError ? red : dim)(lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n…（共 ${lines.length} 行）` : "")) + "\n");
          }
          break;
        case "approval_request": {
          const r = e.request;
          const desc = r.toolName === "bash" ? `$ ${r.args.command}` : `${r.toolName} ${r.args.path}`;
          const ans = (await ask(`\n⚠ ${r.reason}：${desc}\n  [y] 允许  [a] 本会话都允许  [n] 拒绝（也可以直接输入拒绝理由） > `)).trim();
          const low = ans.toLowerCase();
          agent.respondApproval(r.id, low === "a" ? { decision: "allow_session" } : low === "y" || low === "" ? { decision: "allow" } : { decision: "deny", feedback: low === "n" ? undefined : ans });
          break;
        }
        case "compaction_start": process.stderr.write(dim("\n[正在压缩上下文…]\n")); break;
        case "compaction_end": process.stderr.write(e.ok ? dim("[上下文已压缩]\n") : red(`[压缩失败：${e.error}]\n`)); break;
        case "retry": process.stderr.write(red(`\n请求失败，${e.delayMs / 1000}s 后重试（${e.attempt}/${e.max}）：${e.error}\n`)); break;
        case "agent_end": resolve(e); break;
      }
    });
  });
  process.on("SIGINT", () => { process.stderr.write(red("\n中断\n")); agent.abort(); });
  await agent.prompt(prompt);
  const end = await done;
  const s = agent.stats();
  console.error(`\n${end.reason === "done" ? green("✓ 完成") : red(`✗ ${end.reason}${end.error ? "：" + end.error : ""}`)} ${dim(`· tokens ↑${s.input} ↓${s.output} · $${s.cost.toFixed(4)} · 会话 ${agent.session.file}`)}`);
  rl.close();
  process.exit(end.reason === "done" ? 0 : 1);
}

const cmd = args[0];
(cmd === "key" ? keyCommand() : cmd === "models" ? Promise.resolve(modelsCommand()) : run()).catch((e) => { console.error(red(String(e?.message || e))); process.exit(1); });
void listModels;
