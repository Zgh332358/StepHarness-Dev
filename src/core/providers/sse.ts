// SSE（Server-Sent Events）解析与 HTTP 请求的公共逻辑
import { ProviderError } from "../types.js";

export interface SseMessage { event?: string; data: string }

/** 把 fetch 的响应体解析成 SSE 消息流 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (line.startsWith(":")) {
          // 注释 / 心跳
        } else {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** 发 POST 请求；非 2xx 时抛出带状态码的 ProviderError */
export async function postStream(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ProviderError(`网络错误：${(err as Error).message}`, undefined, true);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.message || j.error || text;
      if (typeof msg !== "string") msg = JSON.stringify(msg);
    } catch {}
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new ProviderError(`HTTP ${res.status}：${msg.slice(0, 800)}`, res.status, retryable);
  }
  return res.body;
}

export function safeJson(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: s };
  }
}
