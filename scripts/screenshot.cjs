// 生成 README 截图：用本地脚本化的模拟服务演示一段完整的工作流程（不调用真实模型）。
//   node scripts/screenshot.cjs
const { _electron: electron } = require("playwright-core");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");

const DEMO = [
  { text: "我先看一下 `utils.js` 的实现。", tool: { name: "read", input: { path: "utils.js" } } },
  { text: "`add` 和 `clamp` 都没有测试。我来补一个测试文件，覆盖边界情况。", tool: { name: "write", input: { path: "utils.test.js", content: 'const assert = require("assert");\nconst { add, clamp } = require("./utils");\n\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nassert.strictEqual(clamp(5, 0, 10), 5);\nassert.strictEqual(clamp(-3, 0, 10), 0);\nassert.strictEqual(clamp(42, 0, 10), 10);\nconsole.log("✓ 5 个断言全部通过");\n' } } },
  { text: "运行一下测试：", tool: { name: "bash", input: { command: "node utils.test.js" } } },
  { text: "测试全部通过。\n\n**改动**\n- 新增 `utils.test.js`，覆盖 `add` 的正负数相加，以及 `clamp` 在范围内、低于下限、高于上限三种情况\n\n**验证**\n- `node utils.test.js` → 5 个断言全部通过（命令在沙箱中运行）\n\n如果项目以后接入 Jest 或 Vitest，可以直接把这些断言迁移成测试用例。" },
];

function mock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "claude-sonnet-demo" }] })); }
        const r = JSON.parse(body);
        const step = DEMO[Math.min(JSON.stringify(r.messages).split('"tool_result"').length - 1, DEMO.length - 1)];
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`);
        send("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 3200, output_tokens: 1 } } });
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: step.text } });
        send("content_block_stop", { index: 0 });
        if (step.tool) {
          send("content_block_start", { index: 1, content_block: { type: "tool_use", id: `t${Date.now()}`, name: step.tool.name, input: {} } });
          send("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.input) } });
          send("content_block_stop", { index: 1 });
        }
        send("message_delta", { delta: { stop_reason: step.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 180 } });
        send("message_stop", {}); res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  const server = await mock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-shot-"));
  const ws = path.join(root, "my-app"), home = path.join(root, "home");
  fs.mkdirSync(ws); fs.mkdirSync(home);
  fs.writeFileSync(path.join(ws, "utils.js"), "function add(a, b) {\n  return a + b;\n}\n\nfunction clamp(x, min, max) {\n  return Math.min(Math.max(x, min), max);\n}\n\nmodule.exports = { add, clamp };\n");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    thinking: "low", approvalMode: "auto-edit", sandbox: true, defaultModel: "anthropic/claude-sonnet-demo",
    providers: [{ id: "anthropic", name: "Anthropic", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKeyEnv: "STEPHARNESS_DEMO_KEY", models: [{ id: "claude-sonnet-demo", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }] }],
  }));
  const app = await electron.launch({
    executablePath: path.join(__dirname, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    args: [path.join(__dirname, ".."), ws], env: { ...process.env, STEPHARNESS_HOME: home, STEPHARNESS_DEMO_KEY: "demo" },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("#model-name")?.textContent === "claude-sonnet-demo");
  await page.fill("#input", "给 utils.js 里的函数补上单元测试，并运行确认通过");
  await page.press("#input", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".tool").length === 3 && document.querySelector("#btn-stop").classList.contains("hidden"), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, "../assets/screenshot.png") });
  await app.close(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("截图已保存到 assets/screenshot.png");
})().catch((e) => { console.error(e); process.exit(1); });
