// OpenAI Responses 协议（GPT-5 系列、o 系列）
import { computeCost, emptyUsage, ProviderError } from "../types.js";
import type { AssistantMessage, Message, ProviderRequest, ToolCallBlock } from "../types.js";
import { postStream, readSse, safeJson } from "./sse.js";

type Item = Record<string, unknown>;

function convertInput(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.content.map((b) => b.type === "text"
          ? { type: "input_text", text: b.text }
          : { type: "input_image", image_url: `data:${b.mimeType};base64,${b.data}` }),
      });
    } else if (m.role === "toolResult") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n");
      out.push({ type: "function_call_output", call_id: m.toolCallId, output: text || "(无输出)" });
      const imgs = m.content.filter((b) => b.type === "image");
      if (imgs.length) out.push({ role: "user", content: [{ type: "input_text", text: `工具 ${m.toolName} 返回的图片：` }, ...imgs.map((b: any) => ({ type: "input_image", image_url: `data:${b.mimeType};base64,${b.data}` }))] });
    } else {
      for (const b of m.content) {
        if (b.type === "thinking") {
          if (b.api === "openai-responses" && b.item) {
            const { id: _id, status: _s, ...rest } = b.item as Record<string, unknown>; // store=false 时不能引用服务端 id
            out.push({ ...rest, summary: (rest.summary as unknown[]) || [] });
          }
        } else if (b.type === "text") {
          if (b.text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] });
        } else {
          out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.arguments ?? {}) });
        }
      }
    }
  }
  return out;
}

export async function streamOpenAIResponses(req: ProviderRequest): Promise<AssistantMessage> {
  const { model, signal, onEvent } = req;
  const body: Record<string, unknown> = {
    model: model.id,
    instructions: req.system,
    input: convertInput(req.messages),
    stream: true,
    store: false,
    max_output_tokens: Math.min(model.maxTokens || 32768, 128000),
  };
  if (req.tools.length) body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  if (model.reasoning && req.thinking !== "off") {
    body.reasoning = { effort: req.thinking, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  const stream = await postStream(`${model.baseUrl.replace(/\/+$/, "")}/responses`, { ...model.headers, authorization: `Bearer ${req.apiKey}` }, body, signal);

  const msg: AssistantMessage = {
    role: "assistant", content: [], api: "openai-responses", model: model.id,
    stopReason: "stop", usage: emptyUsage(), timestamp: Date.now(),
  };
  const byOutput = new Map<number, number>(); // output_index -> content index
  const rawArgs = new Map<number, string>();

  for await (const sse of readSse(stream, signal)) {
    if (sse.data === "[DONE]") break;
    let ev: Record<string, any>;
    try { ev = JSON.parse(sse.data); } catch { continue; }
    const oi = ev.output_index as number;
    switch (ev.type) {
      case "response.output_item.added": {
        const it = ev.item || {};
        const i = msg.content.length;
        if (it.type === "reasoning") msg.content.push({ type: "thinking", thinking: "", api: "openai-responses" });
        else if (it.type === "message") msg.content.push({ type: "text", text: "" });
        else if (it.type === "function_call") {
          msg.content.push({ type: "toolCall", id: it.call_id, name: it.name, arguments: {} });
          rawArgs.set(i, "");
          onEvent({ type: "toolcall_start", index: i, id: it.call_id, name: it.name });
        } else break;
        byOutput.set(oi, i);
        break;
      }
      case "response.output_text.delta": {
        const i = byOutput.get(oi); if (i == null) break;
        (msg.content[i] as any).text += ev.delta;
        onEvent({ type: "text_delta", index: i, delta: ev.delta });
        break;
      }
      case "response.reasoning_summary_text.delta": case "response.reasoning_text.delta": {
        const i = byOutput.get(oi); if (i == null) break;
        (msg.content[i] as any).thinking += ev.delta;
        onEvent({ type: "thinking_delta", index: i, delta: ev.delta });
        break;
      }
      case "response.reasoning_summary_part.done": {
        const i = byOutput.get(oi); if (i == null) break;
        (msg.content[i] as any).thinking += "\n\n";
        break;
      }
      case "response.function_call_arguments.delta": {
        const i = byOutput.get(oi); if (i == null) break;
        rawArgs.set(i, (rawArgs.get(i) || "") + ev.delta);
        onEvent({ type: "toolcall_delta", index: i, delta: ev.delta });
        break;
      }
      case "response.output_item.done": {
        const i = byOutput.get(oi); if (i == null) break;
        const it = ev.item || {}, b = msg.content[i];
        if (b.type === "thinking") { b.item = it; b.thinking = b.thinking.trim(); }
        else if (b.type === "toolCall") (b as ToolCallBlock).arguments = safeJson(it.arguments ?? rawArgs.get(i) ?? "");
        else if (b.type === "text" && Array.isArray(it.content)) b.text = it.content.map((c: any) => c.text || "").join("");
        onEvent({ type: "block_end", index: i, block: b });
        break;
      }
      case "response.completed": case "response.incomplete": {
        const r = ev.response || {}, u = r.usage || {};
        const cached = u.input_tokens_details?.cached_tokens || 0;
        msg.usage.input = (u.input_tokens || 0) - cached;
        msg.usage.cacheRead = cached;
        msg.usage.output = u.output_tokens || 0;
        if (ev.type === "response.incomplete") msg.stopReason = "length";
        break;
      }
      case "response.failed": case "error": {
        const e = ev.response?.error || ev.error || ev;
        throw new ProviderError(`${e.code || "error"}：${e.message || sse.data}`, undefined, true);
      }
    }
  }
  if (msg.content.some((b) => b.type === "toolCall") && msg.stopReason === "stop") msg.stopReason = "toolUse";
  msg.usage.cost = computeCost(model, msg.usage);
  return msg;
}
