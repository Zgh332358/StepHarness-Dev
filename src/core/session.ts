// 会话持久化：每个会话一个 JSONL 文件，按工作区分目录存放在 ~/.stepharness/sessions/
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STEPHARNESS_DIR } from "./config.js";
import type { Message } from "./types.js";

export const SESSIONS_DIR = path.join(STEPHARNESS_DIR, "sessions");

export interface SessionMeta {
  id: string;
  path: string;
  cwd: string;
  title: string;
  created: number;
  updated: number;
}

type Line =
  | { type: "session"; version: 1; id: string; cwd: string; created: number }
  | { type: "message"; message: Message }
  | { type: "title"; title: string }
  /** 压缩：之后的上下文 = [摘要, 压缩前最后 keep 条消息] */
  | { type: "compaction"; summary: Message; keep: number };

const encodeCwd = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

export class SessionStore {
  private written = false;
  title = "";

  private constructor(public readonly id: string, public readonly file: string, public readonly cwd: string, public readonly created: number) {}

  static create(cwd: string): SessionStore {
    const id = randomUUID();
    const created = Date.now();
    const stamp = new Date(created).toISOString().replace(/[:.]/g, "-");
    const file = path.join(SESSIONS_DIR, encodeCwd(cwd), `${stamp}_${id.slice(0, 8)}.jsonl`);
    return new SessionStore(id, file, cwd, created);
  }

  /**
   * 加载会话。messages 是发给模型的上下文（已应用压缩），
   * display 是给界面显示的完整记录（包含被压缩掉的旧消息和摘要标记）。
   */
  static load(file: string): { store: SessionStore; messages: Message[]; display: Message[] } {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let header: Extract<Line, { type: "session" }> | undefined;
    let messages: Message[] = [];
    const display: Message[] = [];
    let title = "";
    for (const l of lines) {
      if (!l.trim()) continue;
      let rec: Line;
      try { rec = JSON.parse(l); } catch { continue; }
      if (rec.type === "session") header = rec;
      else if (rec.type === "message") { messages.push(rec.message); display.push(rec.message); }
      else if (rec.type === "title") title = rec.title;
      else if (rec.type === "compaction") {
        messages = [rec.summary, ...(rec.keep > 0 ? messages.slice(-rec.keep) : [])];
        display.push(rec.summary);
      }
    }
    if (!header) throw new Error(`不是有效的会话文件：${file}`);
    const store = new SessionStore(header.id, file, header.cwd, header.created);
    store.written = true;
    store.title = title;
    return { store, messages, display };
  }

  /** 第一条消息写入时才真正创建文件，避免产生空会话 */
  private write(line: Line) {
    if (!this.written) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const header: Line = { type: "session", version: 1, id: this.id, cwd: this.cwd, created: this.created };
      fs.writeFileSync(this.file, JSON.stringify(header) + "\n", { mode: 0o600 }); // 会话里有完整对话和文件内容
      if (this.title) fs.appendFileSync(this.file, JSON.stringify({ type: "title", title: this.title }) + "\n");
      this.written = true;
    }
    fs.appendFileSync(this.file, JSON.stringify(line) + "\n");
  }

  append(message: Message) { this.write({ type: "message", message }); }

  appendCompaction(summary: Message, keep: number) { this.write({ type: "compaction", summary, keep }); }

  setTitle(title: string) {
    this.title = title;
    if (this.written) this.write({ type: "title", title });
  }

  get exists() { return this.written; }

  static list(cwd?: string): SessionMeta[] {
    const dirs: string[] = [];
    if (cwd) dirs.push(path.join(SESSIONS_DIR, encodeCwd(cwd)));
    else { try { for (const d of fs.readdirSync(SESSIONS_DIR)) dirs.push(path.join(SESSIONS_DIR, d)); } catch {} }
    const out: SessionMeta[] = [];
    for (const dir of dirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const file = path.join(dir, f);
        try { out.push(readMeta(file)); } catch {}
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  static remove(file: string) {
    fs.rmSync(assertSessionFile(file), { force: true });
  }
}

/** 确认路径确实是会话目录下的 .jsonl 文件（防止 ../ 穿越），返回规范化后的路径 */
export function assertSessionFile(file: string): string {
  const resolved = path.resolve(file);
  const root = path.resolve(SESSIONS_DIR);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !resolved.endsWith(".jsonl")) throw new Error("不是 StepHarness 的会话文件");
  return resolved;
}

function readMeta(file: string): SessionMeta {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, 128 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    let header: any, title = "", firstUser = "";
    for (const l of buf.toString("utf8").split("\n")) {
      if (!l.trim()) continue;
      let r: any;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.type === "session") header = r;
      else if (r.type === "title") title = r.title;
      else if (!firstUser && r.type === "message" && r.message?.role === "user") {
        firstUser = (r.message.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
      }
    }
    // 标题可能在文件末尾（后来改名），单独扫一下末尾
    if (st.size > buf.length) {
      const tail = Buffer.alloc(Math.min(st.size, 64 * 1024));
      fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
      for (const l of tail.toString("utf8").split("\n")) { try { const r = JSON.parse(l); if (r.type === "title") title = r.title; } catch {} }
    }
    if (!header) throw new Error("bad session");
    return { id: header.id, path: file, cwd: header.cwd, title: title || firstUser.slice(0, 80) || "未命名会话", created: header.created, updated: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}
