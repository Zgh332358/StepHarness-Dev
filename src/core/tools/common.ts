// 工具的公共定义与辅助函数
import os from "node:os";
import path from "node:path";
import type { ImageBlock, TextBlock, ToolSpec } from "../types.js";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  /** 执行中的增量输出（例如 bash 的实时输出） */
  onUpdate: (text: string) => void;
  /** 命令沙箱：开启时 bash 在沙箱中运行 */
  sandbox?: { enabled: boolean; writableRoots?: string[] };
}
export interface ToolOutput {
  content: (TextBlock | ImageBlock)[];
  isError?: boolean;
  details?: Record<string, unknown>;
}
export interface Tool {
  spec: ToolSpec;
  /** read：只读；write：修改文件；exec：执行命令 */
  kind: "read" | "write" | "exec";
  execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutput>;
}

export class ToolError extends Error {}

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export function resolvePath(cwd: string, p: unknown): string {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("缺少 path 参数");
  let s = p.trim();
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(cwd, s);
}

export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export const text = (t: string): TextBlock => ({ type: "text", text: t });

/** 保留开头，按行数和字节数截断 */
export function truncateHead(s: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
  const lines = s.split("\n");
  let out: string[] = [], bytes = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l, "utf8") + 1;
    if (out.length >= maxLines || bytes + b > maxBytes) break;
    out.push(l); bytes += b;
  }
  return { text: out.join("\n"), truncated: out.length < lines.length, shownLines: out.length, totalLines: lines.length };
}

/** 保留结尾（命令输出最重要的通常在最后） */
export function truncateTail(s: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
  const lines = s.split("\n");
  const out: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i], "utf8") + 1;
    if (out.length >= maxLines || bytes + b > maxBytes) break;
    out.unshift(lines[i]); bytes += b;
  }
  return { text: out.join("\n"), truncated: out.length < lines.length, shownLines: out.length, totalLines: lines.length };
}

// ---------- 行级 diff（给界面展示用） ----------
export interface DiffLine { t: " " | "-" | "+"; s: string; a?: number; b?: number }

export function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  // 按逻辑行比较：末尾的换行符不算额外一行，否则新建文件会多算一行
  const split = (s: string) => {
    const arr = s ? s.split("\n") : [];
    if (arr.length && arr[arr.length - 1] === "") arr.pop();
    return arr;
  };
  const A = split(oldText), B = split(newText);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  let mid: DiffLine[] = [];
  if (a.length * b.length <= 4_000_000) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { mid.push({ t: " ", s: a[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { mid.push({ t: "+", s: b[j], b: pre + j + 1 }); j++; }
      else { mid.push({ t: "-", s: a[i], a: pre + i + 1 }); i++; }
    }
  } else {
    mid = [...a.map((s, i) => ({ t: "-" as const, s, a: pre + i + 1 })), ...b.map((s, j) => ({ t: "+" as const, s, b: pre + j + 1 }))];
  }
  const headStart = Math.max(0, pre - context);
  const head = A.slice(headStart, pre).map((s, k) => ({ t: " " as const, s, a: headStart + k + 1, b: headStart + k + 1 }));
  const tailStartA = A.length - suf, tailStartB = B.length - suf;
  const tail = A.slice(tailStartA, Math.min(A.length, tailStartA + context)).map((s, k) => ({ t: " " as const, s, a: tailStartA + k + 1, b: tailStartB + k + 1 }));
  const out: DiffLine[] = [...head];
  let run: DiffLine[] = [];
  const flushRun = () => {
    if (run.length > context * 2 + 1) out.push(...run.slice(0, context), { t: " ", s: "⋯" }, ...run.slice(-context));
    else out.push(...run);
    run = [];
  };
  for (const d of mid) {
    if (d.t === " ") run.push(d);
    else { if (run.length) flushRun(); out.push(d); }
  }
  if (run.length) flushRun();
  out.push(...tail);
  return out;
}

export function diffStats(d: DiffLine[]) {
  return { added: d.filter((x) => x.t === "+").length, removed: d.filter((x) => x.t === "-").length };
}

export type { ToolSpec };
