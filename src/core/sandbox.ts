// 命令沙箱（macOS Seatbelt）。
// 策略：默认全部禁止，只开放运行开发工具所需的最小权限：
//   - 可以读文件（但读不到私钥、凭据等敏感位置）
//   - 只能写工作区、临时目录和额外允许的目录（.git/hooks、.git/config 除外）
//   - 只能访问本机 localhost 网络，不能访问外网
//   - 不能通过 LaunchServices / AppleEvents 在沙箱外启动程序（open、osascript）
// 子进程会继承沙箱限制。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
}

export interface SandboxOptions {
  cwd: string;
  /** 额外允许写入的目录 */
  writableRoots?: string[];
  /** 用于定位敏感文件的家目录（测试时可替换） */
  home?: string;
}

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** SBPL 字符串字面量转义 */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** 沙箱里读不到的位置（相对家目录） */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".config/gh", ".config/gcloud", ".azure", ".docker", "Library/Keychains", ".password-store"];
const SECRET_FILES = [".netrc", ".git-credentials", ".pypirc", ".stepharness/config.json", ".stepharness/secrets.json", ".npmrc",
  // 其他编程助手保存凭据的位置
  ".pi/agent/auth.json", ".codex/auth.json", ".claude/.credentials.json"];
/** 即使在工作区里也不能写的位置：写进去的内容会在沙箱外被执行（shell 启动脚本、登录项等） */
const PROTECTED_HOME = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".gitconfig",
  ".config/git", ".ssh", ".stepharness", ".pi", "Library/LaunchAgents", "Library/LaunchDaemons", "Library/Application Support/com.apple.backgroundtaskmanagementagent"];

export function buildProfile(opts: SandboxOptions): string {
  const cwd = real(opts.cwd);
  const home = real(opts.home ?? os.homedir());
  // 只开放本用户的临时目录（$TMPDIR）和 /tmp，不开放整个 /private/var/folders（里面还有各应用的缓存目录）
  const tmp = [real(os.tmpdir()), "/private/tmp"].filter((p, i, a) => a.indexOf(p) === i);
  const writable = [cwd, ...tmp, ...(opts.writableRoots ?? []).map(real)];

  return `(version 1)
(deny default)

; ---- 进程 ----
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow process-info-pidinfo)
(allow process-info-setcontrol (target same-sandbox))

; ---- 系统信息、共享内存、终端 ----
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow user-preference-read)
(allow ipc-posix-sem)
(allow ipc-posix-shm*)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+"))
(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow iokit-get-properties)
(allow file-ioctl (regex #"^/dev/"))

; ---- 只开放这些系统服务（不包含 LaunchServices、AppleEvents，避免在沙箱外启动程序） ----
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.logd")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.distributed_notifications@Uv3")
  (global-name "com.apple.FSEvents"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))
(allow ipc-posix-shm-read* (ipc-posix-name-regex #"^/tmp/com\\.apple\\.csseed"))

; ---- 文件：可读，敏感位置除外 ----
(allow file-read*)
(deny file-read*
${SECRET_DIRS.map((d) => `  (subpath ${q(path.join(home, d))})`).join("\n")}
${SECRET_FILES.map((f) => `  (literal ${q(path.join(home, f))})`).join("\n")})

; ---- 文件：只能写这些目录 ----
(allow file-write*
${writable.map((w) => `  (subpath ${q(w)})`).join("\n")})
; 写进去会在沙箱外被执行的位置
(deny file-write*
  (subpath ${q(path.join(cwd, ".git", "hooks"))})
  (literal ${q(path.join(cwd, ".git", "config"))})
${PROTECTED_HOME.map((p) => `  (subpath ${q(path.join(home, p))})`).join("\n")})

; ---- 网络：只允许本机 ----
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket (subpath ${q(cwd)})))
${tmp.map((t) => `(allow network-outbound (remote unix-socket (subpath ${q(t)})))`).join("\n")}
(allow system-socket)
`;
}

/** 把命令包装成在沙箱中运行 */
export function sandboxedCommand(command: string, opts: SandboxOptions): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ["-p", buildProfile(opts), "/bin/bash", "-c", command] };
}

/** 输出里像是被沙箱拦下的迹象 */
export function looksSandboxDenied(output: string): boolean {
  return /operation not permitted|permission denied|sandbox|could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|EPERM|EACCES|network is unreachable|Failed to connect|Connection refused|nodename nor servname|Temporary failure in name resolution|read-only file system/i.test(output);
}
