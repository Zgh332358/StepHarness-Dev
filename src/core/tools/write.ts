import fs from "node:fs/promises";
import path from "node:path";
import { diffStats, lineDiff, resolvePath, text, ToolError, type Tool } from "./common.js";

export const writeTool: Tool = {
  kind: "write",
  spec: {
    name: "write",
    description: "创建新文件或整体覆盖已有文件，会自动创建父目录。修改已有文件的局部内容时请优先使用 edit。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "完整的文件内容" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, ctx) {
    const file = resolvePath(ctx.cwd, args.path);
    if (typeof args.content !== "string") throw new ToolError("缺少 content 参数");
    const old = await fs.readFile(file, "utf8").catch(() => null);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, args.content);
    const diff = lineDiff(old ?? "", args.content);
    const stats = diffStats(diff);
    return {
      content: [text(`${old == null ? "已创建" : "已覆盖"} ${file}（${Buffer.byteLength(args.content)} 字节）`)],
      details: { path: file, created: old == null, diff: diff.slice(0, 3000), ...stats },
    };
  },
};

export const editTool: Tool = {
  kind: "write",
  spec: {
    name: "edit",
    description:
      "通过精确文本替换修改文件。每个 oldText 必须与文件中的内容逐字符一致（包括缩进和空白），并且在文件中只出现一次。" +
      "多处修改放在同一次调用的 edits 数组里，它们都基于修改前的原文件匹配，不能互相重叠。oldText 尽量短，但要足以唯一定位。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        edits: {
          type: "array",
          description: "要做的替换",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "要被替换的原文（必须唯一）" },
              newText: { type: "string", description: "替换后的文本" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  async execute(args, ctx) {
    const file = resolvePath(ctx.cwd, args.path);
    let edits = args.edits as { oldText: string; newText: string }[] | undefined;
    // 兼容模型直接传 oldText/newText 的写法
    if (!Array.isArray(edits) && typeof args.oldText === "string") edits = [{ oldText: args.oldText, newText: args.newText ?? "" }];
    if (!Array.isArray(edits) || !edits.length) throw new ToolError("edits 不能为空");
    const raw = await fs.readFile(file, "utf8").catch(() => { throw new ToolError(`文件不存在：${file}`); });
    const crlf = raw.includes("\r\n");
    const original = crlf ? raw.replace(/\r\n/g, "\n") : raw;
    const norm = (s: string) => (crlf ? s.replace(/\r\n/g, "\n") : s);

    const spans: { start: number; end: number; newText: string }[] = [];
    edits.forEach((e, k) => {
      if (typeof e?.oldText !== "string" || !e.oldText) throw new ToolError(`第 ${k + 1} 处修改缺少 oldText`);
      const oldText = norm(e.oldText);
      const first = original.indexOf(oldText);
      if (first < 0) {
        const hint = original.includes(oldText.trim()) ? "（去掉首尾空白后能找到，请检查缩进和换行）" : "（请先用 read 查看文件当前内容）";
        throw new ToolError(`第 ${k + 1} 处修改：在 ${file} 中找不到 oldText ${hint}`);
      }
      if (original.indexOf(oldText, first + 1) >= 0) throw new ToolError(`第 ${k + 1} 处修改：oldText 在文件中出现了多次，请加入更多上下文使其唯一`);
      spans.push({ start: first, end: first + oldText.length, newText: norm(String(e.newText ?? "")) });
    });
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) throw new ToolError("多处修改的 oldText 互相重叠，请合并成一处");

    let result = original;
    for (let i = spans.length - 1; i >= 0; i--) result = result.slice(0, spans[i].start) + spans[i].newText + result.slice(spans[i].end);
    if (result === original) throw new ToolError("修改后内容没有变化");
    await fs.writeFile(file, crlf ? result.replace(/\n/g, "\r\n") : result);
    const diff = lineDiff(original, result);
    const stats = diffStats(diff);
    return {
      content: [text(`已修改 ${file}：${spans.length} 处替换，+${stats.added} -${stats.removed} 行`)],
      details: { path: file, diff: diff.slice(0, 3000), ...stats },
    };
  },
};
