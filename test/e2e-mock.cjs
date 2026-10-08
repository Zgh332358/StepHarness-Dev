// 桌面界面端到端测试（使用本地模拟模型，不调用真实模型、不需要 API Key）
//   node test/e2e-mock.cjs [Electron 可执行文件]
const { _electron: electron } = require("playwright-core");
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { start } = require("./mock-anthropic.cjs");

const bin = process.argv[2] || path.join(__dirname, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const packaged = bin.includes(".app/Contents/MacOS/") && !bin.includes("node_modules/electron");
let fail = 0;
const check = (ok, name, extra = "") => { console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${name}${extra ? ` \x1b[2m${String(extra).slice(0, 140)}\x1b[0m` : ""}`); if (!ok) fail++; };

(async () => {
  const mock = await start();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-mock-ws-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-mock-home-"));
  // 从空配置开始：没有任何模型服务。Key 写进一个临时的钥匙串条目，测试结束后删除
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ thinking: "off", approvalMode: "auto-edit", sandbox: true, autoCompact: true }));
  const keychainService = `StepHarness-e2e-${process.pid}`;
  // 无论测试成功还是中途失败，都删除临时钥匙串条目和临时目录
  const cleanup = () => {
    if (process.platform === "darwin") try { execFileSync("/usr/bin/security", ["delete-generic-password", "-s", keychainService, "-a", "mock"], { stdio: "ignore" }); } catch {}
    fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  const app = await electron.launch({ executablePath: bin, args: [...(packaged ? [] : [path.join(__dirname, "..")]), ws], env: { ...process.env, STEPHARNESS_HOME: home, STEPHARNESS_KEYCHAIN_SERVICE: keychainService } });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  await page.waitForFunction(() => document.querySelector("#model-name")?.textContent, null, { timeout: 20000 });
  check((await page.innerText("#ws-name")) === path.basename(ws), "打开测试工作区");

  // ---------------- 首次使用：添加模型服务（自定义 API Key） ----------------
  check(await page.isVisible("#onboard"), "没有配置服务时显示引导");
  check((await page.innerText("#model-name")) === "未配置模型", "顶栏提示未配置模型");
  await page.click("#onboard-btn");
  await page.selectOption("#pv-preset", "custom-anthropic");
  await page.fill("#pv-name", "模拟服务");
  check((await page.inputValue("#pv-id")) === "custom-anthropic" || (await page.inputValue("#pv-id")) === "", "选择自定义预设时不预填 ID");
  await page.fill("#pv-name", "模拟服务");
  await page.fill("#pv-id", "mock");
  await page.fill("#pv-base", `http://127.0.0.1:${mock.port}`);
  await page.fill("#pv-key", "wrong-key");
  await page.click("#pv-fetch");
  await page.waitForFunction(() => /401|Invalid/.test(document.querySelector("#pv-status")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  check(/401/.test(await page.innerText("#pv-status")), "Key 错误时获取模型列表给出提示", await page.innerText("#pv-status"));
  await page.fill("#pv-key", "mock-key");
  await page.click("#pv-fetch");
  await page.waitForFunction(() => /成功/.test(document.querySelector("#pv-status")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  check((await page.inputValue("#pv-models")).split("\n").includes("mock-claude"), "从服务获取到模型列表", await page.inputValue("#pv-models"));
  await page.click("#pv-save");
  await page.waitForSelector(".prov", { timeout: 5000 }).catch(() => {});
  check(/Key：macOS 钥匙串|Key：~\/\.stepharness/.test(await page.innerText(".prov")), "服务列表显示 Key 已保存", await page.innerText(".prov").catch(() => ""));
  await page.click("#set-cancel");
  check((await page.innerText("#model-name")) === "mock-claude" && !(await page.isVisible("#onboard")), "保存后自动选中模型、引导消失");
  const cfgText = fs.readFileSync(path.join(home, "config.json"), "utf8");
  check(!cfgText.includes("mock-key"), "Key 没有写进 config.json");
  const leaked = await page.evaluate(async () => JSON.stringify(await window.stepharness.call("providers")) + JSON.stringify(await window.stepharness.call("getSettings")) + JSON.stringify(await window.stepharness.call("snapshot")));
  check(!leaked.includes("mock-key"), "界面能调用的接口都拿不到 Key");
  if (process.platform === "darwin") {
    let stored = "";
    try { stored = execFileSync("/usr/bin/security", ["find-generic-password", "-s", keychainService, "-a", "mock", "-w"], { encoding: "utf8" }).trim(); } catch {}
    check(stored.startsWith("b64:") && Buffer.from(stored.slice(4), "base64").toString() === "mock-key", "Key 保存在 macOS 钥匙串里");
  }
  // 模型选择器按服务分组
  await page.click("#model-btn");
  check(/模拟服务/.test(await page.innerText("#model-items")) && /mock-claude-mini/.test(await page.innerText("#model-items")), "模型选择器按服务分组显示");
  await page.keyboard.press("Escape");

  const send = async (text) => {
    await page.fill("#input", text);
    await page.press("#input", "Enter");
    await page.waitForFunction(() => !document.querySelector("#btn-stop").classList.contains("hidden") || document.querySelector(".approval"), null, { timeout: 10000 }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if (await page.$(".approval")) return "approval";
      if (await page.$eval("#btn-stop", (b) => b.classList.contains("hidden"))) return "done";
      await page.waitForTimeout(150);
    }
    return "timeout";
  };
  const lastCard = async () => (await page.$$eval(".tool-head", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")))).pop() || "";

  // ---------------- 沙箱 ----------------
  check((await page.innerText("#sandbox-pill")) === "沙箱", "顶栏显示沙箱已开启");
  const outside = path.join(os.homedir(), `stepharness-e2e-sbx-${Date.now()}`);
  let r = await send(`运行命令:touch ${outside}`);
  check(r === "done", "自动编辑模式：沙箱内命令不询问，直接运行", r);
  check(!fs.existsSync(outside), "沙箱拦住了写家目录");
  check(/沙箱/.test(await lastCard()), "命令卡片标记为「沙箱」", await lastCard());

  r = await send("运行命令:echo 工作区内容 > in.txt && cat in.txt");
  check(r === "done" && fs.existsSync(path.join(ws, "in.txt")), "沙箱内可以写工作区");

  r = await send("沙箱外运行:echo 在沙箱外");
  check(r === "approval", "申请在沙箱外运行时弹出审批");
  const reason = await page.$eval(".approval .q", (e) => e.innerText).catch(() => "");
  check(/沙箱外/.test(reason) && /模拟：这个命令需要联网/.test(reason), "审批里显示模型给出的理由", reason);
  await page.click(".approval [data-d=allow]");
  await page.waitForSelector("#btn-stop.hidden", { state: "attached", timeout: 15000 });
  check(/沙箱外/.test(await lastCard()), "批准后卡片标记为「沙箱外」", await lastCard());

  // ---------------- 自动压缩（阈值） ----------------
  r = await send("触发压缩");
  const before = await page.$$eval("#messages > div:not(.compaction)", (e) => e.length);
  r = await send("继续下一步");
  await page.waitForSelector(".compaction", { timeout: 15000 }).catch(() => {});
  const divider = await page.$eval(".compaction .line", (e) => e.innerText).catch(() => "");
  check(/自动压缩/.test(divider), "上下文接近上限时自动压缩，显示分隔线", divider);
  check((await page.$$eval("#messages > div:not(.compaction)", (e) => e.length)) >= before, "压缩后旧消息仍然显示在界面上");
  await page.click(".compaction summary");
  check(/模拟摘要/.test(await page.$eval(".compaction .md", (e) => e.innerText).catch(() => "")), "可以展开查看摘要");
  const reqAfter = mock.log[mock.log.length - 1];
  check(JSON.stringify(reqAfter.messages).includes("[上下文已压缩]") && !JSON.stringify(reqAfter.messages).includes("触发压缩"), "压缩后发给模型的是摘要，不再包含旧消息");
  check(/收到：继续下一步/.test(await page.$$eval(".asst .md", (e) => e.map((x) => x.innerText).join("|"))), "压缩后任务正常继续");

  // ---------------- 手动压缩 ----------------
  await page.click("#ctx");
  await page.waitForFunction(() => document.querySelectorAll(".compaction").length >= 2, null, { timeout: 15000 }).catch(() => {});
  check((await page.$$(".compaction")).length >= 2 && /手动/.test(await page.$$eval(".compaction .line", (e) => e.pop().innerText)), "点击上下文用量可以手动压缩");

  // ---------------- 超长错误后压缩重试 ----------------
  await page.click("#btn-new"); await page.waitForTimeout(400);
  await send("先说一句话");
  r = await send("超长测试");
  check(/超出上限/.test(await page.$eval(".compaction .line", (e) => e.innerText).catch(() => "")), "模型报告超长时自动压缩", r);
  check(!(await page.$(".err")), "压缩后重试成功，没有残留错误");
  check(/收到：超长测试/.test(await page.$$eval(".asst .md", (e) => e.map((x) => x.innerText).join("|"))), "重试后得到正常回复");

  // ---------------- 会话重新打开后保留压缩记录 ----------------
  const sessions = await page.$$("#session-list li[data-path]");
  await sessions[1].click(); await page.waitForTimeout(600);
  await (await page.$$("#session-list li[data-path]"))[0].click(); await page.waitForTimeout(600);
  check((await page.$$(".compaction")).length === 1, "重新打开会话后压缩分隔线仍在");

  // ---------------- 读取敏感文件需要批准 ----------------
  fs.writeFileSync(path.join(ws, ".env"), "SECRET_TOKEN=abc123\n");
  r = await send("读取文件:.env");
  const sensReason = await page.$eval(".approval .q", (e) => e.innerText).catch(() => "");
  check(r === "approval" && /敏感/.test(sensReason), "读取 .env 时弹出敏感文件审批", sensReason);
  await page.click(".approval [data-d=deny]");
  await page.waitForSelector("#btn-stop.hidden", { state: "attached", timeout: 15000 });
  check(!(await page.$$eval(".asst", (els) => els.some((e) => e.innerText.includes("abc123")))), "拒绝后密钥内容没有出现在对话中");

  // ---------------- 关闭沙箱 ----------------
  await page.click("#sandbox-pill");
  await page.waitForTimeout(300);
  check((await page.innerText("#sandbox-pill")) === "无沙箱", "可以关闭沙箱");
  r = await send("运行命令:touch closed.txt");
  check(r === "approval", "关闭沙箱后，自动编辑模式下命令需要询问", r);
  await page.click(".approval [data-d=allow]");
  await page.waitForSelector("#btn-stop.hidden", { state: "attached", timeout: 15000 });
  await page.click("#sandbox-pill"); await page.waitForTimeout(200);
  check((await page.innerText("#sandbox-pill")) === "沙箱", "重新开启沙箱");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  check(cfg.sandbox === true, "沙箱设置已保存");

  check(!errors.length, "页面没有报错", errors.join(" | "));
  await app.close();
  mock.server.close();
  fs.rmSync(outside, { force: true });
  console.log(fail ? `\n\x1b[31m${fail} 项失败\x1b[0m` : "\n\x1b[32m界面端到端测试（模拟模型）全部通过\x1b[0m");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试失败：", e); process.exit(1); });
