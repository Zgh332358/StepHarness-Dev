// StepHarness 内核：所有模块共享的类型定义。
// 消息格式与具体模型厂商无关，各 provider 负责与自己的协议互相转换。

export type Api = "anthropic-messages" | "openai-completions" | "openai-responses";
export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type ApprovalMode = "ask" | "auto-edit" | "full-auto";

// ---------- 内容块 ----------
export interface TextBlock { type: "text"; text: string }
export interface ImageBlock { type: "image"; data: string; mimeType: string }
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** 产生这段思考的协议；只回放给同一协议 */
  api?: Api;
  /** Anthropic 的签名 */
  signature?: string;
  /** Anthropic redacted_thinking 的数据 */
  redactedData?: string;
  /** OpenAI Responses 的 reasoning item（含 encrypted_content） */
  item?: unknown;
}
export interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

// ---------- 消息 ----------
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 美元 */
  cost: number;
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: (TextBlock | ImageBlock)[];
  timestamp: number;
  /** 有这个字段说明这是一条上下文压缩产生的摘要 */
  compaction?: { tokensBefore: number; reason: string };
}
export interface AssistantMessage {
  role: "assistant";
  content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
  api: Api;
  model: string;
  stopReason: StopReason;
  errorMessage?: string;
  usage: Usage;
  timestamp: number;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextBlock | ImageBlock)[];
  isError: boolean;
  /** 给界面用的结构化信息（diff、退出码等），不会发给模型 */
  details?: Record<string, unknown>;
  timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------- 模型 ----------
export interface ModelInfo {
  id: string;
  name: string;
  api: Api;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown> | null;
  /** 服务要求的额外请求头 */
  headers?: Record<string, string>;
}

// ---------- 工具 ----------
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

// ---------- provider 流式事件 ----------
export type StreamEvent =
  | { type: "text_delta"; index: number; delta: string }
  | { type: "thinking_delta"; index: number; delta: string }
  | { type: "toolcall_start"; index: number; id: string; name: string }
  | { type: "toolcall_delta"; index: number; delta: string }
  | { type: "block_end"; index: number; block: AssistantMessage["content"][number] };

export interface ProviderRequest {
  model: ModelInfo;
  apiKey: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  thinking: ThinkingLevel;
  signal: AbortSignal;
  onEvent: (e: StreamEvent) => void;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
}

export function computeCost(model: ModelInfo, u: Usage): number {
  const c = model.cost;
  return (u.input * c.input + u.output * c.output + u.cacheRead * c.cacheRead + u.cacheWrite * c.cacheWrite) / 1e6;
}
