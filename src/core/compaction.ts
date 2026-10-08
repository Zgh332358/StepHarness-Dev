// 上下文压缩：对话太长时，把较早的部分总结成摘要，只保留最近几轮的原文。
import type { Message, ModelInfo, UserMessage } from "./types.js";

/** 粗略估算一条消息占用的 token（中文约 1.5 字/token，英文约 4 字符/token，取保守值） */
export function estimateTokens(m: Message): number {
  let chars = 0, images = 0;
  for (const b of m.content as any[]) {
    if (!b) continue;
    if (b.type === "text") chars += b.text.length;
    else if (b.type === "thinking") chars += (b.thinking || "").length;
    else if (b.type === "toolCall") chars += b.name.length + JSON.stringify(b.arguments ?? {}).length;
    else if (b.type === "image") images++;
  }
  return Math.ceil(chars / 2.5) + images * 1600 + 8;
}

const isCompactionSummary = (m: Message) => m.role === "user" && !!m.compaction;

/**
 * 当前上下文大小的估算：以最近一次模型调用实际报告的用量为基准，
 * 加上之后新增消息的估算值。压缩之后还没调用过模型时，全部用估算值。
 */
export function contextEstimate(messages: Message[], systemTokens = 3000): number {
  let base = -1, from = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isCompactionSummary(m)) break;
    if (m.role === "assistant") {
      const u = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output;
      if (u > 0) { base = u; from = i + 1; break; }
    }
  }
  if (base < 0) return systemTokens + messages.reduce((n, m) => n + estimateTokens(m), 0);
  return base + messages.slice(from).reduce((n, m) => n + estimateTokens(m), 0);
}

/** 触发自动压缩的上限：80% 窗口，并给输出留出空间 */
export function compactionLimit(model: ModelInfo, ratio = 0.8): number {
  const window = model.contextWindow || 128000;
  const reserve = Math.min(model.maxTokens || 32000, 32000) + 4000;
  return Math.max(4000, Math.min(Math.floor(window * ratio), window - reserve));
}

/** 保留原文的最近部分的预算 */
export function keepBudget(model: ModelInfo): number {
  return Math.max(2000, Math.min(30000, Math.floor((model.contextWindow || 128000) * 0.2)));
}

/**
 * 选择切分点：[0, cut) 被总结，[cut, end) 保留原文。
 * 切分点必须落在用户消息上，这样保留部分里的工具调用和结果总是成对的。
 * 返回 messages.length 表示全部总结（例如当前这一轮本身就很长）。
 */
export function chooseCut(messages: Message[], budget: number): number {
  let acc = 0, cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]);
    if (acc > budget) break;
    cut = i;
  }
  while (cut < messages.length && !(messages[cut].role === "user" && !isCompactionSummary(messages[cut]))) cut++;
  return cut;
}

/** 截取过长文本：保留开头和结尾 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…（中间省略 ${s.length - max} 字符）…\n${s.slice(-half)}`;
}

/** 把要总结的消息转成文字记录（工具输出截短、去掉思考和图片），大幅减少总结请求的体积 */
export function buildTranscript(messages: Message[], maxChars: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
      const imgs = m.content.filter((b) => b.type === "image").length;
      if (m.compaction) parts.push(`【更早对话的摘要】\n${text}`);
      else parts.push(`【用户】${text}${imgs ? `（附带 ${imgs} 张图片）` : ""}`);
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) parts.push(`【助手】${b.text}`);
        else if (b.type === "toolCall") parts.push(`【调用工具 ${b.name}】${clip(JSON.stringify(b.arguments ?? {}), 1500)}`);
      }
      if (m.stopReason === "error") parts.push(`【出错】${m.errorMessage ?? ""}`);
    } else {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
      parts.push(`【工具结果 ${m.toolName}${m.isError ? "（失败）" : ""}】${clip(text, 2000)}`);
    }
  }
  let out = parts.join("\n\n");
  if (out.length > maxChars) {
    // 太长时保留开头的旧摘要（如果有）和最近的内容
    const head = parts[0]?.startsWith("【更早对话的摘要】") ? clip(parts[0], Math.floor(maxChars * 0.3)) + "\n\n" : "";
    out = head + "…（更早的内容过长，已省略）…\n\n" + out.slice(-(maxChars - head.length));
  }
  return out;
}

export const COMPACTION_SYSTEM = `你负责为一个编程助手压缩对话历史。助手之后只能看到你写的摘要和最近几轮对话，所以摘要必须足够详细，让它能无缝继续工作。

请按以下结构书写（用对话中用户使用的语言）：
1. 用户的目标：用户最初想做什么，以及过程中提出的所有明确要求、偏好和限制。
2. 已完成的工作：修改或创建了哪些文件（写出路径）、关键改动是什么、运行过哪些重要命令及结果。
3. 当前状态：做到哪一步了，遇到了哪些问题或错误，是否已解决、怎么解决的。
4. 关键信息：后续可能用到的代码片段、函数名、配置值、命令、报错信息等，原样保留。
5. 下一步：还没完成的事项和接下来的计划。

只根据对话内容书写，不要编造；不需要寒暄或额外说明。`;

export function summaryMessage(summary: string, tokensBefore: number, reason: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[上下文已压缩] 为节省上下文，之前的对话被总结如下。请基于这份摘要继续工作；如需确认细节，可以重新读取相关文件。\n\n<summary>\n${summary.trim()}\n</summary>` }],
    timestamp: Date.now(),
    compaction: { tokensBefore, reason },
  };
}

/** 模型返回的错误是否表示上下文超长 */
export function isOverflowError(message?: string): boolean {
  return !!message && /prompt is too long|context.?length|context_length_exceeded|maximum context|too many tokens|exceeds? (the )?(model'?s? )?(context|maximum)|input is too long|reduce the length|token limit|context window|请求.*过长|上下文.*(超过|超出|过长|超长|太长)|超出.*上下文/i.test(message);
}
