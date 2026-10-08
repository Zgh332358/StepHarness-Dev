import type { AssistantMessage, ProviderRequest } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAIChat } from "./openai-chat.js";
import { streamOpenAIResponses } from "./openai-responses.js";

/** 根据模型的协议类型分发到对应实现 */
export function streamModel(req: ProviderRequest): Promise<AssistantMessage> {
  switch (req.model.api) {
    case "anthropic-messages": return streamAnthropic(req);
    case "openai-completions": return streamOpenAIChat(req);
    case "openai-responses": return streamOpenAIResponses(req);
    default: throw new Error(`不支持的协议：${(req.model as { api: string }).api}`);
  }
}
