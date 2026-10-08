// 配置：模型服务（provider）、用户偏好。存放在 ~/.stepharness/config.json。
// API Key 不在这里，见 secrets.ts。
import fs from "node:fs";
import { dataDir } from "./paths.js";
import { deleteSecret, getSecret, secretStoreName } from "./secrets.js";
import type { Api, ApprovalMode, ModelInfo, ThinkingLevel } from "./types.js";
import path from "node:path";

export const STEPHARNESS_DIR = dataDir();
const CONFIG_FILE = path.join(STEPHARNESS_DIR, "config.json");

/** 一个模型服务下的模型。除 id 外都可以省略，省略时按模型名推断 */
export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  /** 美元 / 百万 token，用于显示费用；不填则显示 $0 */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
}

/** 用户添加的模型服务 */
export interface ProviderConfig {
  /** 小写字母、数字和短横线，作为模型标识的前缀：<id>/<模型> */
  id: string;
  name: string;
  api: Api;
  baseUrl: string;
  /** 可选：从这个环境变量读取 Key（只有你明确填写了才会读） */
  apiKeyEnv?: string;
  /** 可选：额外的请求头（例如网关要求的标识） */
  headers?: Record<string, string>;
  models: ProviderModel[];
}

export interface StepHarnessConfig {
  providers?: ProviderConfig[];
  /** <provider>/<model> */
  defaultModel?: string;
  thinking?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  lastCwd?: string;
  recentCwds?: string[];
  /** 命令沙箱，默认开启 */
  sandbox?: boolean;
  /** 沙箱里额外允许写入的目录 */
  sandboxWritableRoots?: string[];
  /** 自动压缩，默认开启 */
  autoCompact?: boolean;
}

export function loadConfig(): StepHarnessConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as StepHarnessConfig; } catch { return {}; }
}

export function saveConfig(patch: Partial<StepHarnessConfig>): StepHarnessConfig {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(STEPHARNESS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600); // 文件已存在时 mode 参数不生效，需要显式收紧
  return next;
}

// ---------- 预设 ----------
export interface ProviderPreset { id: string; name: string; api: Api; baseUrl: string; apiKeyEnv?: string; note?: string }

/** 常见服务的预设：只是帮你填好地址和协议，Key 和模型由你自己提供 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "anthropic", name: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "openai", name: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "stepfun", name: "阶跃星辰 StepFun", api: "openai-completions", baseUrl: "https://api.stepfun.com/v1", apiKeyEnv: "STEPFUN_API_KEY" },
  { id: "moonshot", name: "Kimi（月之暗面）", api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
  { id: "zhipu", name: "智谱 GLM", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY" },
  { id: "dashscope", name: "通义千问（阿里云百炼）", api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY" },
  { id: "openrouter", name: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  { id: "custom-openai", name: "自定义（OpenAI 兼容）", api: "openai-completions", baseUrl: "", note: "填写服务地址，通常以 /v1 结尾" },
  { id: "custom-anthropic", name: "自定义（Anthropic 兼容）", api: "anthropic-messages", baseUrl: "", note: "填写服务地址，不含 /v1/messages" },
];

// ---------- 模型服务 ----------
export function listProviders(cfg = loadConfig()): ProviderConfig[] { return cfg.providers ?? []; }
export function getProvider(id: string, cfg = loadConfig()): ProviderConfig | undefined { return listProviders(cfg).find((p) => p.id === id); }

const APIS: Api[] = ["anthropic-messages", "openai-completions", "openai-responses"];

/** 校验并规范化服务配置，出错时抛出可读的错误 */
export function validateProvider(input: ProviderConfig): ProviderConfig {
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("服务 ID 只能包含小写字母、数字和短横线（1-40 个字符）");
  const name = String(input.name ?? "").trim() || id;
  if (!APIS.includes(input.api)) throw new Error(`不支持的 API 类型：${input.api}`);
  let baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new Error("服务地址需要以 http:// 或 https:// 开头");
  // 常见的误填：把完整接口路径当成地址
  baseUrl = baseUrl.replace(/\/(v1\/messages|chat\/completions|responses)$/, "");
  if (/^http:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(baseUrl)) {
    throw new Error("为了保护 API Key，只允许 https 地址（本机 localhost 除外）");
  }
  const apiKeyEnv = input.apiKeyEnv?.trim() || undefined;
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error("环境变量名不合法");
  const seen = new Set<string>();
  const models = (input.models ?? []).map((m) => ({ ...m, id: String(m.id ?? "").trim() })).filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
  const headers = input.headers && typeof input.headers === "object" ? Object.fromEntries(Object.entries(input.headers).filter(([k, v]) => /^[\w-]+$/.test(k) && typeof v === "string")) : undefined;
  return { id, name, api: input.api, baseUrl, apiKeyEnv, headers: headers && Object.keys(headers).length ? headers : undefined, models };
}

export function saveProvider(input: ProviderConfig, opts: { isNew?: boolean } = {}): ProviderConfig {
  const p = validateProvider(input);
  const list = listProviders();
  const exists = list.some((x) => x.id === p.id);
  if (opts.isNew && exists) throw new Error(`已经有 ID 为「${p.id}」的服务了`);
  saveConfig({ providers: exists ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p] });
  return p;
}

export function removeProvider(id: string) {
  const cfg = loadConfig();
  const patch: Partial<StepHarnessConfig> = { providers: listProviders(cfg).filter((p) => p.id !== id) };
  if (cfg.defaultModel?.startsWith(`${id}/`)) patch.defaultModel = undefined;
  saveConfig(patch);
  deleteSecret(id);
}

// ---------- API Key ----------
/**
 * 某个服务的 Key：只来自你明确提供的地方 ——
 *   1. 你为这个服务指定的环境变量（apiKeyEnv）
 *   2. 你在设置里保存的 Key（钥匙串）
 * 不会读取其他程序保存的凭据，也不会自动读取任何未指定的环境变量。
 */
export function resolveApiKey(providerId: string, cfg = loadConfig()): string {
  const p = getProvider(providerId, cfg);
  if (!p) return "";
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv]!;
  return getSecret(p.id) ?? "";
}

export function apiKeySource(providerId: string, cfg = loadConfig()): { source: string; ok: boolean } {
  const p = getProvider(providerId, cfg);
  if (!p) return { source: "未配置", ok: false };
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return { source: `环境变量 ${p.apiKeyEnv}`, ok: true };
  if (getSecret(p.id)) return { source: secretStoreName(), ok: true };
  return { source: "未配置", ok: false };
}

// ---------- 模型 ----------
interface Guess { contextWindow: number; maxTokens: number; reasoning: boolean; vision: boolean }
/** 按模型名推断能力，只是保守的默认值；可以在配置文件里为每个模型单独指定 */
const FAMILIES: { match: RegExp; g: Guess }[] = [
  { match: /claude/i, g: { contextWindow: 200000, maxTokens: 32000, reasoning: true, vision: true } },
  { match: /^(gpt-5|o[1-9])|\/(gpt-5|o[1-9])/i, g: { contextWindow: 400000, maxTokens: 64000, reasoning: true, vision: true } },
  { match: /gpt-4/i, g: { contextWindow: 128000, maxTokens: 16384, reasoning: false, vision: true } },
  { match: /gemini/i, g: { contextWindow: 1000000, maxTokens: 32768, reasoning: true, vision: true } },
  { match: /deepseek/i, g: { contextWindow: 128000, maxTokens: 8192, reasoning: true, vision: false } },
  { match: /kimi|moonshot/i, g: { contextWindow: 128000, maxTokens: 16384, reasoning: true, vision: false } },
  { match: /glm/i, g: { contextWindow: 128000, maxTokens: 16384, reasoning: true, vision: false } },
  { match: /qwen|qwq/i, g: { contextWindow: 128000, maxTokens: 8192, reasoning: true, vision: false } },
  { match: /step/i, g: { contextWindow: 64000, maxTokens: 8192, reasoning: false, vision: false } },
];
const FALLBACK: Guess = { contextWindow: 64000, maxTokens: 8192, reasoning: false, vision: false };
const VISION_HINT = /(^|[-/_])(vl|vision|4o|omni)([-._]|$)|\dv([-.]|$)/i;
const ADAPTIVE_THINKING = /(opus[-.](4[-.]7|5)|sonnet[-.]5|fable[-.]5)/;

export function toModelInfo(p: ProviderConfig, m: ProviderModel): ModelInfo {
  const g = FAMILIES.find((f) => f.match.test(m.id))?.g ?? FALLBACK;
  let compat = m.compat;
  if (!compat) {
    if (p.api === "anthropic-messages" && ADAPTIVE_THINKING.test(m.id)) compat = { forceAdaptiveThinking: true };
    // OpenAI 官方的新模型在 Chat Completions 里要求 max_completion_tokens
    if (p.api === "openai-completions") compat = { maxTokensField: /api\.openai\.com/.test(p.baseUrl) ? "max_completion_tokens" : "max_tokens" };
  }
  return {
    id: m.id,
    name: m.name || m.id,
    api: p.api,
    provider: p.id,
    baseUrl: p.baseUrl,
    reasoning: m.reasoning ?? g.reasoning,
    input: m.input ?? (g.vision || VISION_HINT.test(m.id) ? ["text", "image"] : ["text"]),
    contextWindow: m.contextWindow ?? g.contextWindow,
    maxTokens: m.maxTokens ?? g.maxTokens,
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: compat ?? null,
    headers: p.headers,
  };
}

export const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** 所有已配置服务下的模型 */
export function listModels(cfg = loadConfig()): ModelInfo[] {
  return listProviders(cfg).flatMap((p) => p.models.map((m) => toModelInfo(p, m)));
}

/** 按 "<服务>/<模型>" 查找；模型 id 本身可以含 /（例如 OpenRouter 的 anthropic/claude-x） */
export function findModel(key: string | undefined, cfg = loadConfig()): ModelInfo | undefined {
  if (!key) return undefined;
  const i = key.indexOf("/");
  if (i <= 0) return undefined;
  const p = getProvider(key.slice(0, i), cfg);
  const m = p?.models.find((x) => x.id === key.slice(i + 1));
  return p && m ? toModelInfo(p, m) : undefined;
}

export function defaultModel(cfg = loadConfig()): ModelInfo | undefined {
  return findModel(cfg.defaultModel, cfg) ?? listModels(cfg)[0];
}

/** 从服务获取可用模型列表（不消耗 token） */
export async function fetchProviderModels(p: ProviderConfig, apiKey: string): Promise<string[]> {
  if (!apiKey) throw new Error("请先填写 API Key");
  const base = p.baseUrl.replace(/\/+$/, "");
  const isAnthropic = p.api === "anthropic-messages";
  const url = isAnthropic ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> = isAnthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...p.headers }
    : { authorization: `Bearer ${apiKey}`, ...p.headers };
  let res: Response;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`连接失败：${(e as Error).message}`); }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch {}
    throw new Error(`HTTP ${res.status}：${msg}`);
  }
  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error("服务返回的不是 JSON，请检查地址是否正确"); }
  const list: any[] = Array.isArray(body) ? body : body.data ?? body.models ?? [];
  // 去掉明显不能用于对话的模型
  const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image-|search-|davinci|babbage|rerank/i;
  return [...new Set(list.map((m) => String(m?.id ?? m?.name ?? "")).filter((id) => id && !NOT_CHAT.test(id)))].sort();
}

export function rememberCwd(cwd: string) {
  const cfg = loadConfig();
  const recent = [cwd, ...(cfg.recentCwds || []).filter((c) => c !== cwd)].slice(0, 12);
  saveConfig({ lastCwd: cwd, recentCwds: recent });
}
