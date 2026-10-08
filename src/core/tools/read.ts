import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePath, text, ToolError, truncateHead, MAX_LINES, MAX_BYTES, type Tool } from "./common.js";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 超过这个大小就流式读取，只读需要的那几行 */
const STREAM_THRESHOLD = 8 * 1024 * 1024;

/** 流式读取第 offset 行起的 limit 行，最多读到 MAX_BYTES，不会把整个文件读进内存 */
async function readLines(file: string, offset: number, limit: number): Promise<{ lines: string[]; reachedEnd: boolean; lineNo: number }> {
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines: string[] = [];
  let lineNo = 0, carry = "", bytes = 0, done = false;
  try {
    for await (const chunk of stream) {
      const parts = (carry + chunk).split("\n");
      carry = parts.pop() ?? "";
      for (const l of parts) {
        lineNo++;
        if (lineNo < offset) continue;
        lines.push(l);
        bytes += Buffer.byteLength(l) + 1;
        if (lines.length >= limit || bytes >= MAX_BYTES) { done = true; break; }
      }
      // 很长的单行也不能无限累积
      if (carry.length > MAX_BYTES * 2) { carry = carry.slice(0, MAX_BYTES); }
      if (done) break;
    }
    if (!done && carry) { lineNo++; if (lineNo >= offset) lines.push(carry); }
  } finally {
    stream.destroy();
  }
  return { lines, reachedEnd: !done, lineNo };
}

export const readTool: Tool = {
  kind: "read",
  spec: {
    name: "read",
    description: `读取文件内容。支持文本文件和图片（png、jpg、gif、webp）。文本默认最多返回 ${MAX_LINES} 行或 50KB，可以用 offset/limit 分段读取大文件。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区或绝对路径）" },
        offset: { type: "number", description: "从第几行开始（从 1 开始）" },
        limit: { type: "number", description: "最多读取多少行" },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx) {
    const file = resolvePath(ctx.cwd, args.path);
    const st = await fsp.stat(file).catch(() => { throw new ToolError(`文件不存在：${file}`); });
    if (st.isDirectory()) {
      const entries = await fsp.readdir(file, { withFileTypes: true });
      const list = entries.slice(0, 500).map((e) => e.name + (e.isDirectory() ? "/" : "")).sort().join("\n");
      return { content: [text(`${file} 是一个目录，包含：\n${list}${entries.length > 500 ? `\n…共 ${entries.length} 项` : ""}`)], details: { path: file, dir: true } };
    }
    if (!st.isFile()) throw new ToolError(`${file} 不是普通文件（可能是设备、管道或套接字），无法读取`);

    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (mime) {
      if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`图片太大（${(st.size / 1048576).toFixed(1)}MB），上限 5MB`);
      const data = (await fsp.readFile(file)).toString("base64");
      return { content: [text(`图片：${file}`), { type: "image", data, mimeType: mime }], details: { path: file, image: true } };
    }

    // 二进制检测只看开头
    const fh = await fsp.open(file, "r");
    const head = Buffer.alloc(Math.min(8000, st.size));
    await fh.read(head, 0, head.length, 0);
    await fh.close();
    if (head.includes(0)) throw new ToolError(`${file} 看起来是二进制文件，无法按文本读取`);

    const offset = Math.max(1, Math.floor(Number(args.offset)) || 1);
    const limit = Math.max(1, Math.floor(Number(args.limit)) || MAX_LINES);

    if (st.size > STREAM_THRESHOLD) {
      const { lines, reachedEnd, lineNo } = await readLines(file, offset, limit);
      if (!lines.length) throw new ToolError(`offset ${offset} 超出文件行数（共 ${lineNo} 行）`);
      const end = offset - 1 + lines.length;
      let out = lines.join("\n");
      out += reachedEnd ? `\n\n[已显示第 ${offset}-${end} 行，已到文件末尾]`
        : `\n\n[文件很大（${(st.size / 1048576).toFixed(0)}MB），已显示第 ${offset}-${end} 行。用 offset=${end + 1} 继续读取，或用 rg / grep 搜索需要的内容]`;
      return { content: [text(out)], details: { path: file, from: offset, to: end, large: true } };
    }

    const all = (await fsp.readFile(file)).toString("utf8");
    const lines = all.split("\n");
    if (offset > lines.length) throw new ToolError(`offset ${offset} 超出文件行数（共 ${lines.length} 行）`);
    const slice = lines.slice(offset - 1, offset - 1 + limit).join("\n");
    const t = truncateHead(slice, limit);
    const end = offset - 1 + t.shownLines;
    let out = t.text;
    if (end < lines.length) out += `\n\n[已显示第 ${offset}-${end} 行，共 ${lines.length} 行。用 offset=${end + 1} 继续读取]`;
    return { content: [text(out || "(空文件)")], details: { path: file, from: offset, to: end, total: lines.length } };
  },
};
