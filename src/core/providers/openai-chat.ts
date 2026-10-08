// OpenAI Chat Completions 协议（DeepSeek、Kimi、GLM、Qwen 等大多数模型）
import { computeCost, emptyUsage, ProviderError } from "../types.js";
import type { AssistantMessage, Message, ProviderRequest, ToolCallBlock } from "../types.js";
import { postStream, readSse, safeJson } from "./sse.js";

type OMsg = Record<string, unknown>;

function convertMessages(system: string, messages: Message[], vision: boolean): OMsg[] {
  const out: OMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      const hasImg = vision && m.content.some((b) => b.type === "image");
      if (!hasImg) out.push({ role: "user", content: m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n") || " " });
      else out.push({
        role: "user",
        content: m.content.map((b) => b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } }),
      });
    } else if (m.role === "toolResult") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: text || (m.content.length ? "(见下方图片)" : "(无输出)") });
      const imgs = m.content.filter((b) => b.type === "image");
      if (imgs.length && vision) {
        out.push({ role: "user", content: [{ type: "text", text: `工具 ${m.toolName} 返回的图片：` }, ...imgs.map((b) => ({ type: "image_url", image_url: { url: `data:${(b as any).mimeType};base64,${(b as any).data}` } }))] });
      }
    } else {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const calls = m.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
      const reasoning = m.content.filter((b) => b.type === "thinking" && b.api === "openai-completions").map((b) => (b as any).thinking).join("");
      if (!text && !calls.length) continue;
      const msg: OMsg = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      // DeepSeek / Kimi 在工具调用的同一轮里要求回传 reasoning_content
      if (reasoning) msg.reasoning_content = reasoning;
      out.push(msg);
    }
  }
  return out;
}

export async function streamOpenAIChat(req: ProviderRequest): Promise<AssistantMessage> {
  const { model, signal, onEvent } = req;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(req.system, req.messages, model.input.includes("image")),
    stream: true,
    stream_options: { include_usage: true },
  };
  const maxField = (model.compat?.maxTokensField as string) || "max_tokens";
  body[maxField] = Math.min(model.maxTokens || 32768, 65536);
  if (req.tools.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const stream = await postStream(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, { ...model.headers, authorization: `Bearer ${req.apiKey}` }, body, signal);

  const msg: AssistantMessage = {
    role: "assistant", content: [], api: "openai-completions", model: model.id,
    stopReason: "stop", usage: emptyUsage(), timestamp: Date.now(),
  };
  // 按到达顺序把思考、正文、工具调用排成内容块
  let thinkingIdx = -1, textIdx = -1;
  const toolIdx = new Map<number, number>(); // OpenAI tool_calls[].index -> content index
  const rawArgs = new Map<number, string>();
  const endBlock = (i: number) => { if (i >= 0 && msg.content[i]) onEvent({ type: "block_end", index: i, block: msg.content[i] }); };

  for await (const sse of readSse(stream, signal)) {
    if (sse.data === "[DONE]") break;
    let ev: Record<string, any>;
    try { ev = JSON.parse(sse.data); } catch { continue; }
    if (ev.error) throw new ProviderError(`${ev.error.message || JSON.stringify(ev.error)}`, undefined, true);
    if (ev.usage) {
      const u = ev.usage, cached = u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0;
      msg.usage.input = (u.prompt_tokens || 0) - cached;
      msg.usage.cacheRead = cached;
      msg.usage.output = u.completion_tokens || 0;
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (reasoning) {
      if (thinkingIdx < 0) { thinkingIdx = msg.content.length; msg.content.push({ type: "thinking", thinking: "", api: "openai-completions" }); }
      (msg.content[thinkingIdx] as any).thinking += reasoning;
      onEvent({ type: "thinking_delta", index: thinkingIdx, delta: reasoning });
    }
    if (d.content) {
      if (textIdx < 0) { endBlock(thinkingIdx); textIdx = msg.content.length; msg.content.push({ type: "text", text: "" }); }
      (msg.content[textIdx] as any).text += d.content;
      onEvent({ type: "text_delta", index: textIdx, delta: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const k = tc.index ?? 0;
      let i = toolIdx.get(k);
      if (i == null) {
        i = msg.content.length;
        toolIdx.set(k, i);
        const id = tc.id || `call_${Date.now()}_${k}`;
        msg.content.push({ type: "toolCall", id, name: tc.function?.name || "", arguments: {} });
        rawArgs.set(i, "");
        onEvent({ type: "toolcall_start", index: i, id, name: tc.function?.name || "" });
      } else if (tc.function?.name) {
        (msg.content[i] as ToolCallBlock).name += tc.function.name;
      }
      const delta = tc.function?.arguments || "";
      if (delta) { rawArgs.set(i, rawArgs.get(i) + delta); onEvent({ type: "toolcall_delta", index: i, delta }); }
    }
    if (choice.finish_reason) {
      const r = choice.finish_reason;
      msg.stopReason = r === "tool_calls" || r === "function_call" ? "toolUse" : r === "length" ? "length" : "stop";
    }
  }
  if (thinkingIdx >= 0 && textIdx < 0) endBlock(thinkingIdx);
  if (textIdx >= 0) endBlock(textIdx);
  for (const [, i] of toolIdx) {
    (msg.content[i] as ToolCallBlock).arguments = safeJson(rawArgs.get(i) || "");
    endBlock(i);
  }
  if (toolIdx.size && msg.stopReason === "stop") msg.stopReason = "toolUse";
  msg.usage.cost = computeCost(model, msg.usage);
  return msg;
}
