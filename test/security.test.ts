// 安全测试：命令白名单绕过、路径逃逸、凭据泄露、XSS、文件权限等
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkApproval, isReadOnlyCommand } from "../src/core/approval.js";
import { SessionStore, SESSIONS_DIR } from "../src/core/session.js";
import { saveConfig, resolveApiKey, saveProvider, removeProvider, STEPHARNESS_DIR } from "../src/core/config.js";
import { setSecret } from "../src/core/secrets.js";
import { bashTool } from "../src/core/tools/bash.js";
import { readTool } from "../src/core/tools/read.js";
import { md } from "../src/renderer/markdown.js";
import { sandboxAvailable, sandboxedCommand } from "../src/core/sandbox.js";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { describe, eq, expect, test } from "./harness.js";

const exec = { kind: "exec" } as any, write = { kind: "write" } as any;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-sec-"));
const ws = fs.realpathSync(tmp);
const ctx = (over: object = {}) => ({ cwd: ws, signal: new AbortController().signal, env: process.env, onUpdate: () => {}, ...over });
const textOf = (o: any) => o.content.map((b: any) => b.text ?? "").join("");

describe("命令白名单：这些命令会写文件或执行任意程序，绝不能自动放行", () => {
  const bypasses: [string, string][] = [
    ["ls & rm -rf x", "单个 & 后台执行拼接"],
    ["command rm -rf x", "command 内建可以执行任意命令"],
    ["find . -fprint /tmp/x", "find -fprint 写文件"],
    ["find . -fprintf /tmp/x '%p'", "find -fprintf 写文件"],
    ["find . -fls /tmp/x", "find -fls 写文件"],
    ["rg --pre 'sh -c id' foo .", "rg --pre 执行任意预处理程序"],
    ["rg --pre=evil foo", "rg --pre= 写法"],
    ["sort -o out.txt in.txt", "sort -o 写文件"],
    ["sort --output=out.txt in.txt", "sort --output 写文件"],
    ["sort --compress-program=sh in.txt", "sort 压缩程序可执行任意命令"],
    ["tree -o out.txt", "tree -o 写文件"],
    ["uniq in.txt out.txt", "uniq 第二个参数是输出文件"],
    ["sed -n 'w /tmp/x' f", "sed 的 w 命令写文件"],
    ["sed 'e id' f", "sed 的 e 命令执行命令"],
    ["fd -X rm", "fd -X 批量执行"],
    ["fd --exec-batch rm", "fd --exec-batch 批量执行"],
    ["git diff --output=/tmp/x", "git diff --output 写文件"],
    ["git log --output=x", "git log --output 写文件"],
    ["git diff --ext-diff", "git 外部 diff 程序"],
    ["git remote add evil https://x", "git remote add 修改配置"],
    ["git remote set-url origin https://x", "git remote set-url 修改配置"],
    ["git branch newbranch", "git branch 创建分支"],
    ["git tag v9", "git tag 创建标签"],
    ["GIT_PAGER='sh -c id' git log", "环境变量指定分页程序"],
    ["PAGER=evil git log", "PAGER 环境变量"],
    ["DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls", "动态库注入"],
    ["ag --pager evil foo", "ag --pager 执行程序"],
    ["hostname evil", "修改主机名"],
    ["less f", "交互式分页器"],
    ["file -C -m x", "file -C 编译写文件"],
    ["echo hi >/dev/nullx", "伪装成 /dev/null 的重定向"],
    ["env rm -rf x", "env 可以执行任意命令"],
    ["find . -name x -exec rm {} ;", "find -exec 执行命令"],
    ["find . -delete", "find -delete 删除文件"],
    ["cat a > b", "重定向写文件"],
    ["ls -la;rm -rf x", "分号拼接"],
    ["git status && rm -rf x", "&& 拼接"],
    ["cat a | sh", "管道交给 shell 执行"],
    ["wc -l < a", "输入重定向"],
    ["xargs rm", "xargs 执行命令"],
    ["tee out.txt", "tee 写文件"],
    ["echo x | tee /tmp/y", "管道后 tee 写文件"],
    ["cp a b", "复制文件"],
    ["mv a b", "移动文件"],
    ["mkdir x", "创建目录"],
    ["touch x", "创建文件"],
    ["npm install", "安装依赖"],
    ["python3 -c 'import os'", "执行脚本"],
    ["git branch -D main", "删除分支"],
    ["git tag -d v1", "删除标签"],
    ["git checkout main", "切换分支"],
    ["git stash", "暂存改动"],
    ["git add .", "暂存文件"],
    ["git commit -m x", "提交"],
    ["git push", "推送"],
    ["ls 2>&1 & rm x", "2>&1 之后用 & 拼接"],
    ["cat a >&2 > b", "混合重定向写文件"],
  ];
  for (const [cmd, why] of bypasses) test(`${why}：${cmd}`, () => eq(isReadOnlyCommand(cmd), false));
});

describe("命令白名单：常用只读命令应该自动放行（避免过度打扰）", () => {
  const ok = ["ls -la", "git status", "git log --oneline -5", "git diff HEAD~1 -- src", "rg -n foo src", "find . -name '*.ts' -not -path './node_modules/*'",
    "cat a | grep b | wc -l", "git branch", "git branch -a", "git remote -v", "git tag", "sort a.txt | uniq -c", "echo hi 2>&1", "ls 2>/dev/null", "cd src && ls",
    "head -50 README.md", "git show HEAD --stat", "grep -rn TODO .", "wc -l src/*.ts", "tree -L 2",
    "git log -5", "git log -n 5", "git log --oneline -20 src/app.ts", "find src -type f -name '*.ts'", "find . -maxdepth 2 -type d -print",
    "head -n 50 README.md", "tail -20 a", "jq -r .name package.json", "diff -u a b", "du -sh src", "git cat-file -p HEAD", "stat -f %z a",
    "file a.txt", "cd /tmp", "ls", "ls -la 2>&1 | head -20"];
  for (const cmd of ok) test(cmd, () => eq(isReadOnlyCommand(cmd), true));
});

describe("文件路径：自动编辑模式下不能借路径绕到工作区外", () => {
  test("工作区内的符号链接指向外部文件 → 需要审批", () => {
    const outside = path.join(os.tmpdir(), `stepharness-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(ws, "link.txt"));
    expect(checkApproval(write, { path: "link.txt" }, "auto-edit", ws, new Set()).needsApproval, "通过符号链接写工作区外文件未被拦截");
  });
  test("工作区内的符号链接目录指向外部 → 需要审批", () => {
    fs.symlinkSync(os.homedir(), path.join(ws, "homelink"));
    expect(checkApproval(write, { path: "homelink/.zshrc" }, "auto-edit", ws, new Set()).needsApproval, "通过符号链接目录写 ~/.zshrc 未被拦截");
  });
  test("写 .git/hooks（下次 git commit 时会执行）→ 需要审批", () => {
    expect(checkApproval(write, { path: ".git/hooks/pre-commit" }, "auto-edit", ws, new Set()).needsApproval);
  });
  test("写 .git/config → 需要审批", () => {
    expect(checkApproval(write, { path: ".git/config" }, "auto-edit", ws, new Set()).needsApproval);
  });
  test("../ 跳出工作区 → 需要审批", () => {
    expect(checkApproval(write, { path: "../evil.txt" }, "auto-edit", ws, new Set()).needsApproval);
  });
  test("普通工作区文件 → 自动", () => {
    expect(!checkApproval(write, { path: "src/a.ts" }, "auto-edit", ws, new Set()).needsApproval);
  });
});

describe("凭据保护", () => {
  test("bash 子进程拿不到 API Key 环境变量", async () => {
    const env = { ...process.env, MODELSPROXY_API_KEY: "sk-test-secret", MPX_API_KEY: "sk-test-2", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };
    const r = await bashTool.execute({ command: "env" }, ctx({ env }));
    for (const s of ["sk-test-secret", "sk-test-2", "sk-ant", "sk-oai"]) expect(!textOf(r).includes(s), `子进程环境里能看到 ${s}`);
  });
  test("配置文件权限为 600", () => {
    saveConfig({ thinking: "low" });
    eq((fs.statSync(path.join(STEPHARNESS_DIR, "config.json")).mode & 0o777).toString(8), "600");
  });
  test("已存在的宽权限配置文件会被收紧为 600", () => {
    fs.chmodSync(path.join(STEPHARNESS_DIR, "config.json"), 0o644);
    saveConfig({ thinking: "low" });
    eq((fs.statSync(path.join(STEPHARNESS_DIR, "config.json")).mode & 0o777).toString(8), "600");
  });
  test("会话文件权限为 600（里面有完整对话和文件内容）", () => {
    const s = SessionStore.create(ws);
    s.append({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
    eq((fs.statSync(s.file).mode & 0o777).toString(8), "600");
    SessionStore.remove(s.file);
  });
});

describe("敏感文件：读取私钥和凭据需要用户同意（避免提示注入把它们发给模型）", () => {
  const read = { kind: "read" } as any;
  for (const p of ["~/.ssh/id_rsa", "~/.aws/credentials", "~/.stepharness/config.json", "~/.stepharness/secrets.json", "~/.pi/agent/auth.json", ".env", ".env.local", "certs/server.key", "~/.netrc", "~/.config/gh/hosts.yml"])
    test(`read ${p} → 需要审批`, () => expect(checkApproval(read, { path: p }, "auto-edit", ws, new Set()).needsApproval));
  for (const c of ["cat ~/.ssh/id_rsa", "cat .env", "grep KEY ~/.aws/credentials", "head ~/.stepharness/config.json", "cat ~/.pi/agent/auth.json"])
    test(`${c} → 需要审批`, () => eq(isReadOnlyCommand(c), false));
  test("普通文件读取仍然自动", () => {
    expect(!checkApproval(read, { path: "src/env.ts" }, "auto-edit", ws, new Set()).needsApproval);
    expect(!checkApproval(read, { path: "README.md" }, "ask", ws, new Set()).needsApproval);
    expect(isReadOnlyCommand("cat src/environment.ts"));
  });
});

describe("API Key 的保护", () => {
  test("Key 不会写进 config.json", () => {
    saveProvider({ id: "sec1", name: "S", api: "openai-completions", baseUrl: "https://a.com/v1", models: [] });
    setSecret("sec1", "sk-should-not-be-in-config");
    expect(!fs.readFileSync(path.join(STEPHARNESS_DIR, "config.json"), "utf8").includes("sk-should-not-be-in-config"));
    removeProvider("sec1");
  });
  test("文件方式保存时 secrets.json 权限为 600", () => {
    setSecret("perm", "sk-x");
    eq((fs.statSync(path.join(STEPHARNESS_DIR, "secrets.json")).mode & 0o777).toString(8), "600");
  });
  test("没有为服务指定环境变量时，不读取常见的 Key 环境变量", () => {
    const saved = { ...process.env };
    Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-env", OPENAI_API_KEY: "sk-oai-env", MODELSPROXY_API_KEY: "sk-mp-env" });
    saveProvider({ id: "anthropic", name: "A", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: [] });
    eq(resolveApiKey("anthropic"), "");
    removeProvider("anthropic");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MODELSPROXY_API_KEY"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
  test("不读取其他程序（例如 pi）保存的凭据", () => {
    expect(!/\.pi\b|auth\.json|models-store/.test(__CONFIG_SRC__), "config.ts 引用了其他程序的配置");
  });
  test("非本机地址必须使用 https（Key 不会明文传输）", () => {
    let threw = false;
    try { saveProvider({ id: "plain", name: "P", api: "openai-completions", baseUrl: "http://example.com/v1", models: [] }); } catch { threw = true; }
    expect(threw);
  });
  test("界面拿到的服务列表里不包含 Key", () => {
    expect(/providers: \(\) => listProviders\(\)\.map\(\(p\) => \(\{ \.\.\.p, key: apiKeySource\(p\.id\) \}\)\)/.test(__MAIN_SRC__), "providers 接口的返回值变了，请确认没有带出 Key");
    expect(!/getSecret\(/.test(__MAIN_SRC__), "主进程直接读取了 Key，可能会传给界面");
  });
});

describe("会话文件操作不能越界", () => {
  test("删除会话时拒绝 ../ 路径穿越", () => {
    const victim = path.join(STEPHARNESS_DIR, "victim.txt");
    fs.writeFileSync(victim, "x");
    let threw = false;
    try { SessionStore.remove(path.join(SESSIONS_DIR, "..", "victim.txt")); } catch { threw = true; }
    expect(threw && fs.existsSync(victim), "路径穿越删除了会话目录之外的文件");
  });
  test("拒绝删除非 .jsonl 文件", () => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const f = path.join(SESSIONS_DIR, "x.txt"); fs.writeFileSync(f, "x");
    let threw = false;
    try { SessionStore.remove(f); } catch { threw = true; }
    expect(threw, "删除了非会话文件");
  });
});

describe("资源耗尽", () => {
  test("读取超大文件不会把整个文件读进内存", async () => {
    const big = path.join(ws, "big.log");
    const line = "这是一行用于测试的日志内容 0123456789 abcdefghijklmnopqrstuvwxyz\n";
    const block = line.repeat(Math.ceil(1024 * 1024 / Buffer.byteLength(line)));
    const fd = fs.openSync(big, "w"); for (let i = 0; i < 200; i++) fs.writeSync(fd, block); fs.closeSync(fd); // 约 200MB 文本
    const before = process.memoryUsage().rss;
    let out = "";
    try { out = textOf(await readTool.execute({ path: "big.log" }, ctx())); } catch (e) { out = (e as Error).message; }
    const grew = (process.memoryUsage().rss - before) / 1048576;
    expect(grew < 100, `读取时内存增长 ${grew.toFixed(0)}MB`);
    expect(out.length < 200_000, "返回内容过大");
    expect(out.includes("测试的日志"), `没有读到内容：${out.slice(0, 200)}`);
    fs.rmSync(big);
  });
});

describe("界面渲染：模型输出和文件内容中的 HTML 不能被执行（XSS 会导致可以调用全部 IPC，等同于执行任意命令）", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[点我](javascript:alert(1))",
    "[点我](https://example.com\" onmouseover=\"alert(1))",
    "https://example.com/\"><img src=x onerror=alert(1)>",
    "```html\n<script>alert(1)</script>\n```",
    "```\"><img src=x onerror=alert(1)>\ncode\n```",
    "| <b onclick=alert(1)>x</b> | y |\n|---|---|\n| <svg onload=alert(1)> | z |",
    "> <iframe src=javascript:alert(1)>",
    "- <a href=javascript:alert(1)>x</a>\n  - **<img src=x onerror=alert(1)>**",
    "`<script>` **`<img onerror=1>`** *<svg/onload=alert(1)>*",
  ];
  for (const p of payloads) test(JSON.stringify(p).slice(0, 60), () => {
    const html = md(p);
    expect(!/<(script|img|iframe|svg|b )/i.test(html), `出现了可执行标签：${html}`);
    expect(!/\son\w+\s*=/i.test(html.replace(/&[a-z#0-9]+;/gi, "")) || !/<[^>]*\son\w+\s*=/i.test(html), `出现了事件属性：${html}`);
    expect(!/href="(?!https?:\/\/)/i.test(html), `出现了非 http 链接：${html}`);
  });
});

describe("命令沙箱实测（真实 sandbox-exec，仅 macOS）", () => {
  if (!sandboxAvailable()) { test("当前系统不支持沙箱，跳过", () => {}); return; }
  const H = os.homedir(), tag = `stepharness-sbx-${process.pid}`;
  const sbxWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sh-sbx-ws-")));
  const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sh-sbx-home-")));
  fs.mkdirSync(path.join(fakeHome, ".ssh")); fs.writeFileSync(path.join(fakeHome, ".ssh/id_rsa"), "PRIVATE-KEY");
  const run = (cmd: string, home = fakeHome) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const { file, args } = sandboxedCommand(cmd, { cwd: sbxWs, home });
    const p = spawn(file, args, { cwd: sbxWs });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), 20000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
  });
  const gone = (f: string) => !fs.existsSync(path.join(H, f));
  let server: http.Server, port = 0;
  test("准备本机测试服务", async () => {
    server = http.createServer((_q, r) => r.end("local-ok"));
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
    port = (server.address() as any).port;
  });
  test("可以写工作区", async () => { const r = await run("echo ok > a.txt && cat a.txt"); eq(r.out, "ok"); });
  test("可以写 $TMPDIR 和 /tmp", async () => { const r = await run(`touch "$TMPDIR/${tag}" /tmp/${tag} && echo ok`); eq(r.out, "ok"); fs.rmSync(`/tmp/${tag}`, { force: true }); });
  test("不能写家目录", async () => { await run(`touch ~/${tag}-a`); expect(gone(`${tag}-a`)); });
  test("子进程继承限制", async () => { await run(`bash -c 'sh -c "touch ~/${tag}-b"'`); expect(gone(`${tag}-b`)); });
  test("不能通过符号链接写到工作区外", async () => { await run(`ln -s ~/${tag}-c link && echo x > link`); expect(gone(`${tag}-c`)); });
  test("不能通过硬链接改写工作区外的文件", async () => {
    const target = path.join(H, `${tag}-d`); fs.writeFileSync(target, "original\n");
    await run(`ln ${target} hl; echo pwned >> hl; true`);
    eq(fs.readFileSync(target, "utf8"), "original\n"); fs.rmSync(target, { force: true });
  });
  test("读不到私钥", async () => { const r = await run(`cat ${fakeHome}/.ssh/id_rsa`); expect(r.code !== 0 && !r.out.includes("PRIVATE-KEY")); });
  test("不能写 .git/hooks", async () => { const r = await run("mkdir -p .git/hooks 2>/dev/null; echo evil > .git/hooks/pre-commit"); expect(r.code !== 0); });
  test("可以写 .git 里的普通文件（git 日常操作）", async () => { const r = await run("mkdir -p .git && echo ref > .git/HEAD && echo ok"); eq(r.out, "ok"); });
  test("可以访问 localhost", async () => { const r = await run(`curl -sS -m 4 http://127.0.0.1:${port}`); eq(r.out, "local-ok"); });
  // 被沙箱拒绝时，connect 会立即返回 EPERM（Operation not permitted），与网络是否可达无关
  const connect = (host: string, p: number) => `python3 -c "import socket;s=socket.socket();s.settimeout(3)
try:
  s.connect(('${host}', ${p})); print('connected')
except Exception as e: print(type(e).__name__, e)"`;
  test("连接外网地址被系统拒绝", async () => {
    for (const host of ["223.5.5.5", "192.0.2.1", "10.255.255.1"]) {
      const r = await run(connect(host, 80));
      expect(/Operation not permitted|PermissionError/.test(r.out), `${host}：${r.out}`);
    }
  });
  test("外网域名无法解析", async () => { const r = await run("curl -sS -m 5 https://example.com 2>&1; true"); expect(/resolve|not permitted|Failed/i.test(r.out), r.out); });
  test("本机自己的局域网 IP 视为本机（与 localhost 等价，不扩大访问范围）", async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return;
    const r = await run(`curl -sS -m 4 http://${lan.address}:${port}`);
    eq(r.out, "local-ok");
  });
  test("不能通过 open 启动程序", async () => { const r = await run(`open -g -a TextEdit /tmp 2>&1; echo rc=$?`); expect(!/rc=0/.test(r.out), r.out); });
  test("不能通过 osascript 在沙箱外执行命令", async () => { await run(`osascript -e 'do shell script "touch ~/${tag}-e"' 2>&1; sleep 1; true`); expect(gone(`${tag}-e`)); });
  test("不能通过 launchctl 提交任务", async () => {
    await run(`launchctl submit -l ${tag} -- /usr/bin/touch ${H}/${tag}-f 2>&1; sleep 2; true`);
    spawnSync("launchctl", ["remove", tag]);
    expect(gone(`${tag}-f`));
  });
  test("node、python3、git、cc 正常工作", async () => {
    const r = await run(`node -e 'console.log("node-ok")' && python3 -c 'print("py-ok")' && git init -q r && cd r && echo x>f && git add f && git -c user.email=a@b -c user.name=a commit -qm i && echo git-ok && cd .. && printf 'int main(){return 0;}' > m.c && cc m.c -o m && ./m && echo cc-ok`);
    for (const k of ["node-ok", "py-ok", "git-ok", "cc-ok"]) expect(r.out.includes(k), `${k} 缺失：${r.out.slice(0, 300)}`);
  });
  test("清理", () => {
    server.close();
    for (const f of fs.readdirSync(H)) if (f.startsWith(tag)) fs.rmSync(path.join(H, f), { force: true });
    fs.rmSync(sbxWs, { recursive: true, force: true }); fs.rmSync(fakeHome, { recursive: true, force: true });
  });
});

declare const __MAIN_SRC__: string, __RENDERER_HTML__: string, __PRELOAD_SRC__: string, __CONFIG_SRC__: string;
describe("Electron 窗口配置（静态检查）", () => {
  const main = __MAIN_SRC__;
  const html = __RENDERER_HTML__;
  test("contextIsolation / sandbox 开启，nodeIntegration 关闭", () => { expect(/contextIsolation: true/.test(main) && /sandbox: true/.test(main) && /nodeIntegration: false/.test(main)); });
  test("CSP 禁止内联脚本", () => { expect(/script-src 'self'/.test(html) && !/script-src[^;"]*unsafe-inline/.test(html)); });
  test("禁止页面跳转和新窗口", () => { expect(/will-navigate/.test(main) && /setWindowOpenHandler/.test(main)); });
  test("拒绝摄像头/麦克风等权限请求", () => { expect(/setPermissionRequestHandler/.test(main), "没有设置权限请求处理"); });
  test("IPC 校验调用来源", () => { expect(/senderFrame/.test(main), "IPC 没有校验调用来源"); });
  test("不暴露任意路径打开（shell.openPath 可执行 .app）", () => { expect(!/openPath:/.test(main), "IPC 暴露了 openPath"); });
  test("openSession 只允许打开会话目录里的文件", () => { expect(/openSession:[^\n]*assertSessionFile|assertSessionFile[\s\S]{0,200}openSession/.test(main), "openSession 没有校验路径"); });
});

export const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
