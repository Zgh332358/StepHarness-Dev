import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { text, ToolError, truncateTail, type Tool } from "./common.js";
import { looksSandboxDenied, sandboxedCommand } from "../sandbox.js";

const DEFAULT_TIMEOUT = 120;
/** 不传给子进程的环境变量：模型网关和各家模型的密钥。命令（以及被提示注入的命令）拿不到它们。 */
const SECRET_ENV = /^(MODELSPROXY_API_KEY|MPX_API_KEY|STEPHARNESS_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|OPENROUTER_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|MOONSHOT_API_KEY|DASHSCOPE_API_KEY|ZHIPU_API_KEY|STEPFUN_API_KEY|XAI_API_KEY)$/;
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) && !k.startsWith("ELECTRON_")) out[k] = v;
  return out;
}
const MAX_TIMEOUT = 1800;
const MAX_KEEP = 4 * 1024 * 1024; // 内存里最多保留 4MB，超出部分写到临时文件

export const bashTool: Tool = {
  kind: "exec",
  spec: {
    name: "bash",
    description:
      `在工作区目录下用 bash 执行命令，返回标准输出和标准错误（合并）。输出过长时只保留最后 2000 行 / 50KB，完整输出会写到临时文件。` +
      `默认超时 ${DEFAULT_TIMEOUT} 秒，可通过 timeout 调整（最多 ${MAX_TIMEOUT} 秒）。不要运行需要交互输入的命令，也不要启动不会退出的前台服务。` +
      `如果启用了沙箱，命令默认在沙箱中运行：只能写工作区和临时目录、不能访问外网（localhost 可以）。确实需要联网或写工作区外时，设置 unsandboxed=true 并在 justification 里说明原因，这需要用户批准。`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 bash 命令" },
        timeout: { type: "number", description: "超时时间（秒）" },
        unsandboxed: { type: "boolean", description: "在沙箱外运行（需要用户批准）。只在命令确实需要联网、或要写工作区之外的位置时使用" },
        justification: { type: "string", description: "unsandboxed=true 时，用一句话向用户说明为什么需要在沙箱外运行" },
      },
      required: ["command"],
    },
  },
  execute(args, ctx) {
    const command = args.command;
    if (typeof command !== "string" || !command.trim()) throw new ToolError("缺少 command 参数");
    const timeout = Math.min(Math.max(Number(args.timeout) || DEFAULT_TIMEOUT, 1), MAX_TIMEOUT);

    const sandboxed = !!ctx.sandbox?.enabled && args.unsandboxed !== true;
    const { file, args: argv } = sandboxed
      ? sandboxedCommand(command, { cwd: ctx.cwd, writableRoots: ctx.sandbox?.writableRoots })
      : { file: "/bin/bash", args: ["-c", command] };

    return new Promise((resolve, reject) => {
      const child = spawn(file, argv, {
        cwd: ctx.cwd,
        env: { ...childEnv(ctx.env), PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb", NO_COLOR: "1" },
        detached: true, // 独立进程组，方便整组结束
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let total = 0;
      let spill: fs.WriteStream | null = null;
      let spillPath = "";
      let timedOut = false;
      const started = Date.now();

      const onData = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        total += chunk.length;
        if (spill) spill.write(chunk);
        out += s;
        if (out.length > MAX_KEEP) {
          if (!spill) {
            spillPath = path.join(os.tmpdir(), `stepharness-bash-${Date.now()}.log`);
            spill = fs.createWriteStream(spillPath);
            spill.write(out);
          }
          out = out.slice(-MAX_KEEP / 2);
        }
        ctx.onUpdate(s);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const killGroup = () => {
        try { process.kill(-child.pid!, "SIGTERM"); } catch {}
        setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 2000);
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeout * 1000);
      const onAbort = () => killGroup();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => { clearTimeout(timer); reject(new ToolError(`无法启动命令：${err.message}`)); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        spill?.end();
        const t = truncateTail(out.replace(/\r(?!\n)/g, "\n"));
        let body = t.text;
        if (t.truncated || spill) {
          if (!spill) { spillPath = path.join(os.tmpdir(), `stepharness-bash-${Date.now()}.log`); fs.writeFileSync(spillPath, out); }
          body = `[输出过长，只显示最后 ${t.shownLines} 行；完整输出（${(total / 1024).toFixed(0)}KB）在 ${spillPath}]\n` + body;
        }
        const notes: string[] = [];
        if (timedOut) notes.push(`命令超时（${timeout} 秒）已被终止`);
        else if (ctx.signal.aborted) notes.push("命令被用户中断");
        else if (code !== 0) notes.push(`退出码 ${code ?? signal}`);
        if (sandboxed && code !== 0 && !timedOut && !ctx.signal.aborted && looksSandboxDenied(out)) {
          notes.push("命令在沙箱中运行，失败可能是因为沙箱限制（不能访问外网、只能写工作区和临时目录、读不到凭据文件）。如果确实需要，用 unsandboxed=true 重新执行并在 justification 中说明原因，这需要用户批准");
        }
        const final = [body || "(无输出)", ...notes.map((n) => `[${n}]`)].join("\n");
        resolve({
          content: [text(final)],
          isError: code !== 0 || timedOut,
          details: { exitCode: code, signal, timedOut, sandboxed, durationMs: Date.now() - started, fullOutputPath: spillPath || undefined },
        });
      });
    });
  },
};
