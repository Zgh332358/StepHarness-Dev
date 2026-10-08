// Anthropic Messages 协议（Claude 系列）
import { computeCost, emptyUsage, ProviderError } from "../types.js";
import type { AssistantMessage, Message, ProviderRequest, ThinkingBlock, ToolCallBlock } from "../types.js";
import { postStream, readSse, safeJson } from "./sse.js";

type Block = Record<string, unknown>;
type AMsg = { role: "user" | "assistant"; content: Block[] };

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "call";

function convertMessages(messages: Message[]): AMsg[] {
  const out: AMsg[] = [];
  const push = (role: AMsg["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); // Anthropic 要求 user/assistant 交替
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") {
      push("user", m.content.map((b) =>
        b.type === "text" ? { type: "text", text: b.text || " " } : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }));
    } else if (m.role === "toolResult") {
      push("user", [{
        type: "tool_result",
        tool_use_id: sanitizeId(m.toolCallId),
        is_error: m.isError || undefined,
        content: m.content.length
          ? m.content.map((b) => b.type === "text" ? { type: "text", text: b.text || " " } : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } })
          : [{ type: "text", text: "(无输出)" }],
      }]);
    } else {
      const blocks: Block[] = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          // 只有同协议、带签名的思考块才能回放
          if (b.api !== "anthropic-messages") continue;
          if (b.redactedData) blocks.push({ type: "redacted_thinking", data: b.redactedData });
          else if (b.signature) blocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
        } else if (b.type === "text") {
          if (b.text.trim()) blocks.push({ type: "text", text: b.text });
        } else {
          blocks.push({ type: "tool_use", id: sanitizeId(b.id), name: b.name, input: b.arguments ?? {} });
        }
      }
      if (m.stopReason === "error" && !blocks.some((b) => b.type === "tool_use")) {
        // 出错的回复不回放（可能只有一半）
        if (!blocks.some((b) => b.type === "text")) continue;
      }
      push("assistant", blocks);
    }
  }
  // 给最后一条消息加缓存断点（prompt caching），大幅降低多轮对话的成本
  const last = out[out.length - 1];
  if (last) {
    const lb = last.content[last.content.length - 1];
    if (lb) lb.cache_control = { type: "ephemeral" };
  }
  return out;
}

export async function streamAnthropic(req: ProviderRequest): Promise<AssistantMessage> {
  const { model, signal, onEvent } = req;
  const adaptive = !!model.compat?.forceAdaptiveThinking;
  const thinkingOn = model.reasoning && req.thinking !== "off";
  const budget = { low: 4000, medium: 12000, high: 32000, off: 0 }[req.thinking];
  let maxTokens = Math.min(model.maxTokens || 32000, 64000);
  if (thinkingOn && !adaptive) maxTokens = Math.max(maxTokens, budget + 8000);

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: maxTokens,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: convertMessages(req.messages),
    stream: true,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
  }
  if (thinkingOn) {
    if (adaptive) { body.thinking = { type: "adaptive" }; body.output_config = { effort: req.thinking }; }
    else body.thinking = { type: "enabled", budget_tokens: budget };
  }

  const stream = await postStream(`${model.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    ...model.headers,
    "x-api-key": req.apiKey,
    "anthropic-version": "2023-06-01",
  }, body, signal);

  const msg: AssistantMessage = {
    role: "assistant", content: [], api: "anthropic-messages", model: model.id,
    stopReason: "stop", usage: emptyUsage(), timestamp: Date.now(),
  };
  const rawArgs = new Map<number, string>();

  for await (const sse of readSse(stream, signal)) {
    if (sse.data === "[DONE]") break;
    let ev: Record<string, any>;
    try { ev = JSON.parse(sse.data); } catch { continue; }
    switch (ev.type) {
      case "message_start": {
        const u = ev.message?.usage || {};
        msg.usage.input = u.input_tokens || 0;
        msg.usage.cacheRead = u.cache_read_input_tokens || 0;
        msg.usage.cacheWrite = u.cache_creation_input_tokens || 0;
        msg.usage.output = u.output_tokens || 0;
        break;
      }
      case "content_block_start": {
        const i = ev.index as number, cb = ev.content_block || {};
        if (cb.type === "text") msg.content[i] = { type: "text", text: "" };
        else if (cb.type === "thinking") msg.content[i] = { type: "thinking", thinking: "", api: "anthropic-messages" };
        else if (cb.type === "redacted_thinking") msg.content[i] = { type: "thinking", thinking: "", api: "anthropic-messages", redactedData: cb.data };
        else if (cb.type === "tool_use") {
          msg.content[i] = { type: "toolCall", id: cb.id, name: cb.name, arguments: {} };
          rawArgs.set(i, "");
          onEvent({ type: "toolcall_start", index: i, id: cb.id, name: cb.name });
        }
        break;
      }
      case "content_block_delta": {
        const i = ev.index as number, d = ev.delta || {}, b = msg.content[i];
        if (!b) break;
        if (d.type === "text_delta" && b.type === "text") { b.text += d.text; onEvent({ type: "text_delta", index: i, delta: d.text }); }
        else if (d.type === "thinking_delta" && b.type === "thinking") { b.thinking += d.thinking; onEvent({ type: "thinking_delta", index: i, delta: d.thinking }); }
        else if (d.type === "signature_delta" && b.type === "thinking") (b as ThinkingBlock).signature = (b.signature || "") + d.signature;
        else if (d.type === "input_json_delta") { rawArgs.set(i, (rawArgs.get(i) || "") + d.partial_json); onEvent({ type: "toolcall_delta", index: i, delta: d.partial_json }); }
        break;
      }
      case "content_block_stop": {
        const i = ev.index as number, b = msg.content[i];
        if (!b) break;
        if (b.type === "toolCall") (b as ToolCallBlock).arguments = safeJson(rawArgs.get(i) || "");
        onEvent({ type: "block_end", index: i, block: b });
        break;
      }
      case "message_delta": {
        const r = ev.delta?.stop_reason;
        if (r) msg.stopReason = r === "tool_use" ? "toolUse" : r === "max_tokens" ? "length" : "stop";
        const u = ev.usage || {};
        if (u.output_tokens != null) msg.usage.output = u.output_tokens;
        if (u.input_tokens) msg.usage.input = u.input_tokens;
        if (u.cache_read_input_tokens) msg.usage.cacheRead = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) msg.usage.cacheWrite = u.cache_creation_input_tokens;
        break;
      }
      case "error": {
        const e = ev.error || {};
        const overloaded = e.type === "overloaded_error" || e.type === "api_error";
        throw new ProviderError(`${e.type || "error"}：${e.message || sse.data}`, undefined, overloaded);
      }
    }
  }
  msg.content = msg.content.filter(Boolean);
  msg.usage.cost = computeCost(model, msg.usage);
  return msg;
}
