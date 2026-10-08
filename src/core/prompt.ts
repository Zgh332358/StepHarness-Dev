// 系统提示词
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STEPHARNESS_DIR } from "./config.js";
import type { ModelInfo, ToolSpec } from "./types.js";

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md", ".stepharness/AGENTS.md"];
const MAX_DOC = 30 * 1024;

function readDoc(file: string): string | undefined {
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    return s ? (s.length > MAX_DOC ? s.slice(0, MAX_DOC) + "\n…（已截断）" : s) : undefined;
  } catch { return undefined; }
}

export function projectDocs(cwd: string): { file: string; content: string }[] {
  const docs: { file: string; content: string }[] = [];
  const global = readDoc(path.join(STEPHARNESS_DIR, "AGENTS.md"));
  if (global) docs.push({ file: path.join(STEPHARNESS_DIR, "AGENTS.md"), content: global });
  for (const name of PROJECT_FILES) {
    const file = path.join(cwd, name);
    const c = readDoc(file);
    if (c) { docs.push({ file, content: c }); break; }
  }
  return docs;
}

export function buildSystemPrompt(opts: { cwd: string; model: ModelInfo; tools: ToolSpec[]; sandbox?: boolean }): string {
  const { cwd, model, tools } = opts;
  const date = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  const platform = process.platform === "darwin" ? `macOS ${os.release()}` : `${process.platform} ${os.release()}`;
  const docs = projectDocs(cwd);

  return `你是 StepHarness，一个运行在用户电脑上的编程助手。你通过工具直接读取和修改用户的文件、执行命令来完成任务。

# 可用工具
${tools.map((t) => `- ${t.name}：${t.description.split("。")[0]}`).join("\n")}

# 工作方式
- 先弄清楚再动手：修改代码前，用 read 和 bash（rg、ls、git 等）了解相关代码和项目结构。
- 修改已有文件优先用 edit 做精确替换；只有新建文件或整体重写时才用 write。
- 改完尽量验证：运行相关测试、类型检查或构建，确认没有破坏原有功能。
- 只做用户要求的事，保持与现有代码风格一致，不要顺手做大范围重构。
- 命令运行在非交互环境：不要用需要输入的命令；长时间运行的服务要放到后台并把输出重定向到文件。
- 可能造成破坏或无法撤销的操作（批量删除、git push --force、修改工作区之外的文件等），先征求用户同意。
- 用户可以拒绝某次工具调用。被拒绝后不要换个方式硬做同一件事，先问清楚用户的想法。
- 多个互不依赖的只读查询可以在一次回复里同时发起。

# 回复风格
- 始终用用户最近一条消息的语言回复，包括调用工具之间的简短说明（用户写中文，就全程用中文）。
- 简洁直接，不要寒暄。完成任务后简要说明改了什么、结果如何；提到文件时写出路径。
- 可以使用 Markdown；代码块要标注语言。

# 环境
- 工作区：${cwd}
- 系统：${platform}（${os.arch()}），Shell：bash
- 今天：${date}
- 当前模型：${model.name}
- 命令沙箱：${opts.sandbox ? "开启。bash 命令在沙箱中运行，只能写工作区和临时目录，不能访问外网（localhost 可以），读不到凭据文件。需要联网（如安装依赖）或写工作区外时，用 unsandboxed=true 并写明 justification，用户批准后才会执行" : "关闭"}
${docs.length ? `\n# 项目说明\n以下内容来自用户提供的说明文件，请遵守：\n${docs.map((d) => `\n<file path="${d.file}">\n${d.content}\n</file>`).join("\n")}\n` : ""}`;
}
