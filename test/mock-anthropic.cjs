// 模拟的 Anthropic Messages 服务：按脚本返回回复，用来在不调用真实模型、不需要真实 API Key 的情况下测试整个应用。
// 用户消息里的指令：
//   运行命令:<cmd>        → 调用 bash
//   沙箱外运行:<cmd>      → 调用 bash 并申请在沙箱外运行
//   写文件:<路径>:<内容>   → 调用 write
//   触发压缩              → 回复时报告接近上限的用量（下一次请求前会自动压缩）
//   超长测试              → 第一次请求返回「上下文超长」错误
//   读取文件:<路径>        → 调用 read
//   其他                  → 回复「收到：…」
// 另外提供 GET /v1/models（模型列表）。
const http = require("node:http");

const COMPACTION_MARK = "你负责为一个编程助手压缩对话历史";

function start(port = 0) {
  const log = [];
  const server = http.createServer((req, res) => {
    const authed = req.headers["x-api-key"] === "mock-key";
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(authed ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(authed ? { data: [{ id: "mock-claude", display_name: "Mock Claude" }, { id: "mock-claude-mini" }] } : { type: "error", error: { type: "authentication_error", message: "Invalid API Key" } }));
    }
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) { res.writeHead(404); return res.end(); }
    if (!authed) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid API Key" } }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body);
      log.push(r);
      const system = (r.system || []).map((b) => b.text).join("");
      const msgs = r.messages || [];
      const last = msgs[msgs.length - 1];
      const blocks = Array.isArray(last?.content) ? last.content : [{ type: "text", text: String(last?.content ?? "") }];
      // 只有最后一块是工具结果时才算「工具刚执行完」；用户在工具结果之后又发的消息会合并到同一条里
      const lastBlock = blocks[blocks.length - 1];
      const toolResult = lastBlock?.type === "tool_result" ? lastBlock : undefined;
      const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
      const userText = texts[texts.length - 1] || "";  // 压缩后摘要和最新请求会合并成一条，取最后一段
      const allText = JSON.stringify(msgs);
      const hasSummary = allText.includes("[上下文已压缩]");

      let reply;
      if (system.includes(COMPACTION_MARK)) {
        reply = { text: "【模拟摘要】用户在测试 StepHarness：运行过若干命令，测试了沙箱和压缩功能。下一步：继续用户的最新请求。" };
      } else if (allText.includes("超长测试") && !hasSummary) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1200000 tokens > 1000000 maximum" } }));
      } else if (toolResult) {
        const t = (Array.isArray(toolResult.content) ? toolResult.content.map((c) => c.text || "").join("") : String(toolResult.content)).slice(0, 120);
        reply = { text: `工具执行完毕：${t}` };
      } else {
        const m = userText.match(/运行命令:(.+)$/m), s = userText.match(/沙箱外运行:(.+)$/m), w = userText.match(/写文件:([^:]+):(.+)$/m), rd = userText.match(/读取文件:(.+)$/m);
        if (rd) reply = { tool: { name: "read", input: { path: rd[1].trim() } } };
        else if (m) reply = { tool: { name: "bash", input: { command: m[1].trim() } } };
        else if (s) reply = { tool: { name: "bash", input: { command: s[1].trim(), unsandboxed: true, justification: "模拟：这个命令需要联网" } } };
        else if (w) reply = { tool: { name: "write", input: { path: w[1].trim(), content: w[2] } } };
        else reply = { text: `收到：${userText.slice(0, 60)}`, inputTokens: userText.includes("触发压缩") ? 950000 : undefined };
      }

      const input = reply.inputTokens ?? Math.ceil(body.length / 3);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", { message: { id: "msg_mock", role: "assistant", content: [], model: r.model, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      if (reply.tool) {
        const id = `toolu_mock_${log.length}`;
        send("content_block_start", { index: 0, content_block: { type: "tool_use", id, name: reply.tool.name, input: {} } });
        const json = JSON.stringify(reply.tool.input);
        send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 10) } });
        send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: json.slice(10) } });
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
      } else {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for (const piece of reply.text.match(/.{1,8}/gs)) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
      }
      send("message_stop", {});
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}

module.exports = { start };
