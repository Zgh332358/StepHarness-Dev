// 审批策略：决定一次工具调用是自动执行，还是先问用户。
// 三档模式（参考 Codex）：
//   ask        每次修改文件、执行非只读命令前都询问
//   auto-edit  工作区内的文件修改自动执行；命令仍需询问（只读命令除外）
//   full-auto  全部自动执行
//
// 只读命令的判断：先分词，再按「全局危险参数表 + 每个命令自己的安全参数表」判断。
// 表里没有的命令、不认识的参数，一律需要审批 —— 宁可多问一次，也不要放过。
import fs from "node:fs";
import path from "node:path";
import type { ApprovalMode } from "./types.js";
import { isInside, resolvePath, type Tool } from "./tools/index.js";

export interface ApprovalCheck {
  needsApproval: boolean;
  reason?: string;
  /** "本会话都允许" 记住的键（多个用换行分隔） */
  sessionKey?: string;
}

/** 敏感文件：私钥、云凭据、各类 token，以及 StepHarness 和其他编程助手（pi、Codex、Claude Code）保存凭据的文件 */
const SENSITIVE = /(^|[\/\s'"=])(\.ssh\/|\.aws\/|\.gnupg\/|\.kube\/config|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.config\/gh\/hosts|\.stepharness\/(config|secrets)\.json|\.pi\/agent\/auth\.json|\.codex\/auth\.json|\.claude\/\.credentials\.json|Library\/Keychains|\.env(\.[\w-]+)?(?=$|[\s'";|&)]))|(id_(rsa|ed25519|ecdsa|dsa)|\.(pem|p12|pfx|key))(?=$|[\s'";|&)])/;
export const isSensitivePath = (p: string) => SENSITIVE.test(" " + p);

/** 命令片段分隔符：单个 & （后台执行）也算 */
const SEGMENT_SEP = /&&|\|\||;|\||&|\n/;

/** 任何命令都不允许的参数（会写文件或执行程序） */
const DANGEROUS = new Set(["o", "output", "outfile", "fprint", "fprintf", "fls",
  "compress-program", "pre", "pre-glob", "pager", "in-place", "exec", "exec-batch", "execdir", "ok", "okdir", "delete",
  "ext-diff", "output-directory", "write", "wait", "jobserver"]);

/** 每个命令允许的参数（值是参数名集合，单个字母按前缀匹配） */
const SAFE: Record<string, { noArgs?: boolean; flags?: Set<string> }> = {
  ls: { flags: new Set(["l", "a", "h", "t", "r", "S", "R", "d", "F", "G", "1", "s", "u", "c", "i", "n", "p", "q", "v", "color", "group-directories-first"]) },
  pwd: { noArgs: true }, whoami: { noArgs: true }, true: { noArgs: true }, false: { noArgs: true },
  echo: { flags: new Set(["n", "e", "E"]) }, printf: { flags: new Set() },
  cat: { flags: new Set(["n", "b", "s", "E", "T", "v", "A", "e", "t", "u"]) },
  head: { flags: new Set(["n", "c", "q", "v", "z"]) }, tail: { flags: new Set(["n", "c", "q", "v", "z", "f", "F", "r"]) },
  wc: { flags: new Set(["l", "w", "c", "m", "L", "c", "M"]) }, nl: { flags: new Set(["b", "s", "w", "v", "n"]) },
  sort: { flags: new Set(["n", "r", "u", "f", "k", "t", "h", "V", "b", "d", "i", "M", "s", "c", "z"]) },
  uniq: { flags: new Set(["c", "d", "u", "i", "f", "s", "w", "z"]) },
  cut: { flags: new Set(["d", "f", "c", "b", "s", "z", "complement", "output-delimiter"]) },
  tr: { flags: new Set(["d", "s", "c", "t"]) }, cmp: { flags: new Set(["s", "l", "b", "i", "n"]) },
  diff: { flags: new Set(["u", "r", "q", "a", "b", "B", "i", "w", "y", "c", "e", "n", "U", "color", "stat", "no-index", "name-only", "unified", "label"]) },
  grep: { flags: new Set(["r", "R", "n", "i", "v", "w", "c", "l", "L", "E", "F", "G", "P", "e", "h", "H", "o", "q", "s", "a", "b", "m", "A", "B", "C", "x", "z", "color", "include", "exclude", "exclude-dir", "only-matching", "line-number", "no-filename", "with-filename", "recursive", "extended-regexp", "fixed-strings", "perl-regexp", "count", "files-with-matches", "invert-match", "word-regexp", "null", "binary", "text", "max-count", "after-context", "before-context", "context", "ignore-case"]) },
  egrep: { flags: new Set(["r", "R", "n", "i", "v", "w", "c", "l", "L", "h", "H", "o", "q", "E"]) },
  fgrep: { flags: new Set(["r", "R", "n", "i", "v", "w", "c", "l", "L", "h", "H", "o", "q", "F"]) },
  rg: { flags: new Set(["n", "i", "w", "v", "c", "l", "L", "F", "o", "q", "s", "a", "b", "m", "A", "B", "C", "e", "g", "t", "T", "j", "M", "d", "u", "p", "N", "U", "z", "H", "h", "x", "0", "8", "?", "color", "no-ignore", "hidden", "glob", "iglob", "type", "type-not", "max-count", "max-depth", "max-columns", "max-filesize", "files", "files-with-matches", "files-without-match", "count", "count-matches", "only-matching", "quiet", "json", "vimgrep", "no-heading", "heading", "no-line-number", "line-number", "multiline", "context", "after-context", "before-context", "ignore-case", "smart-case", "case-sensitive", "word-regexp", "invert-match", "fixed-strings", "pcre2", "sort", "sortr", "threads", "stats", "encoding", "help"]) },
  find: { flags: new Set(["print", "printf", "ls", "name", "iname", "path", "ipath", "not", "type", "maxdepth", "mindepth", "size", "newer", "mtime", "atime", "ctime", "inum", "perm", "user", "group", "empty", "prune", "o", "a", "regex", "iregex", "depth", "follow", "P", "H", "L", "print0", "quit", "true", "false", "readable", "writable", "executable", "links", "xdev"]) },
  fd: { flags: new Set(["e", "t", "d", "s", "i", "g", "L", "H", "I", "u", "a", "l", "c", "p", "j", "x", "color", "hidden", "no-ignore", "ignore-case", "glob", "extension", "type", "max-depth", "min-depth", "exact-depth", "max-results", "follow", "absolute-path", "prune", "help", "version"]) },
  tree: { flags: new Set(["L", "a", "d", "f", "i", "s", "h", "C", "n", "P", "I", "p", "u", "g", "D", "F", "prune", "filelimit", "gitignore", "help", "version"]) },
  file: { flags: new Set(["b", "i", "h", "L", "m", "r", "s", "z", "mime", "mime-type", "mime-encoding", "brief", "no-dereference", "help", "version"]) },
  stat: { flags: new Set(["c", "f", "L", "t", "x", "format", "printf", "help", "version"]) },
  du: { flags: new Set(["s", "h", "k", "m", "a", "c", "d", "L", "x", "b", "g", "max-depth", "human-readable", "summarize", "all", "total", "apparent-size", "help", "version"]) },
  df: { flags: new Set(["h", "H", "k", "m", "g", "i", "T", "P", "a", "l", "human-readable", "help", "version"]) },
  jq: { flags: new Set(["r", "c", "n", "e", "s", "j", "a", "M", "C", "S", "raw-output", "compact-output", "null-input", "exit-status", "slurp", "join-output", "sort-keys", "tab", "arg", "args", "help", "version"]) },
  md5: { flags: new Set() }, shasum: { flags: new Set(["a", "b", "c", "p", "s", "0", "1", "2", "4", "5", "6", "256", "384", "512", "algorithm", "check", "binary", "text", "status", "warn", "help", "version", "ignore-missing"]) },
  basename: { flags: new Set(["a", "s", "z"]) }, dirname: { flags: new Set(["z"]) }, realpath: { flags: new Set(["e", "m", "s", "q", "relative-to", "relative-base", "canonicalize-existing", "canonicalize-missing"]) },
  readlink: { flags: new Set(["f", "m", "n", "e", "q", "s", "v", "canonicalize", "canonicalize-existing", "canonicalize-missing", "no-newline", "quiet", "silent", "verbose"]) },
  which: { flags: new Set(["a", "s", "all"]) }, type: { flags: new Set(["a", "t", "p", "P", "f", "all", "type", "path", "force"]) },
  uname: { flags: new Set(["a", "s", "n", "r", "v", "m", "p", "i", "o", "all", "kernel-name", "nodename", "kernel-release", "kernel-version", "machine", "processor", "hardware-platform", "operating-system"]) },
  hostname: { noArgs: true },
  date: { flags: new Set(["u", "I", "R", "s", "r", "v", "utc", "iso-8601", "rfc-2822", "rfc-3339", "help", "version"]) },
  test: { flags: new Set(["e", "f", "d", "h", "L", "n", "z", "r", "w", "x", "s", "t"]) },
  "[": { flags: new Set(["e", "f", "d", "h", "L", "n", "z", "r", "w", "x", "s", "t"]) },
};

/** git 只读子命令：分别是「无参数」或「允许的参数」 */
const GIT_READ: Record<string, Set<string> | "none"> = {
  status: new Set(["s", "b", "u", "short", "porcelain", "branch", "long", "ignored", "untracked-files", "no-ahead-behind"]),
  log: new Set(["n", "oneline", "stat", "p", "patch", "graph", "decorate", "all", "author", "grep", "since", "until", "reverse", "follow", "format", "pretty", "name-only", "name-status", "numstat", "shortstat", "abbrev-commit", "no-merges", "first-parent", "date", "max-count", "skip", "merges"]),
  diff: new Set(["u", "stat", "name-only", "name-status", "cached", "staged", "no-index", "color", "word-diff", "p", "patch", "unified", "function-context", "ignore-all-space", "ignore-space-change", "diff-filter", "find-renames", "histogram", "minimal", "src-prefix", "dst-prefix"]),
  show: new Set(["stat", "oneline", "name-only", "name-status", "s", "p", "patch", "format", "pretty", "no-patch", "abbrev-commit", "color", "summary"]),
  branch: new Set(["a", "v", "r", "l", "all", "verbose", "remote", "list", "show-current", "contains", "merged", "no-merged", "sort", "format", "color", "no-color", "points-at"]),
  tag: new Set(["l", "n", "list", "sort", "contains", "format", "no-color", "points-at", "merged"]),
  remote: new Set(["v", "verbose", "no-color"]),
  "rev-parse": new Set(["verify", "short", "abbrev-ref", "is-inside-work-tree", "show-toplevel", "git-dir", "show-prefix", "quiet", "symbolic-full-name", "default", "sq", "not", "end-of-options", "all", "branches", "tags", "remotes"]),
  blame: new Set(["L", "l", "p", "porcelain", "w", "s", "t", "c", "M", "C", "date", "root", "show-stats", "line-porcelain", "abbrev"]),
  describe: new Set(["tags", "always", "long", "all", "dirty", "abbrev", "match", "exclude", "contains", "first-parent", "candidates"]),
  shortlog: new Set(["s", "n", "e", "summary", "numbered", "email", "all", "no-merges", "format"]),
  "ls-files": new Set(["z", "c", "d", "m", "o", "i", "s", "u", "t", "v", "stage", "cached", "deleted", "modified", "others", "ignored", "unmerged", "deduplicate", "eol", "exclude-standard"]),
  config: new Set(["get", "get-all", "get-regexp", "list", "l", "local", "global", "system", "show-origin", "type", "default", "name-only", "includes", "null", "z"]),
  "symbolic-ref": new Set(["short", "quiet"]),
  "merge-base": new Set(["a", "all", "is-ancestor", "octopus", "independent", "fork-point"]),
  "cat-file": new Set(["t", "s", "e", "p", "type", "size", "exists", "pretty", "batch", "batch-check", "batch-all-objects", "textconv", "filters"]),
  grep: new Set(["n", "i", "w", "v", "c", "l", "L", "e", "E", "F", "G", "P", "h", "H", "o", "q", "a", "b", "m", "A", "B", "C", "x", "z", "extended-regexp", "fixed-strings", "perl-regexp", "line-number", "ignore-case", "invert-match", "word-regexp", "count", "files-with-matches", "only-matching", "all-match", "max-depth", "and", "or", "not", "break", "heading", "cached", "untracked", "no-index", "recurse-submodules", "threads", "color"]),
  "count-objects": new Set(["v", "verbose", "H", "human-readable"]),
  "check-ignore": new Set(["v", "q", "n", "no-index", "verbose", "quiet", "non-matching", "stdin", "z"]),
  "var": new Set(["l", "list"]),
  "whatchanged": new Set(["n", "oneline", "stat", "p", "patch", "all", "since", "until"]),
  "reflog": new Set(["n", "oneline", "all", "date", "max-count"]),
  "help": new Set(["a", "all", "g", "guides", "c", "config", "w", "web", "m", "man", "i", "info", "no-external-commands"]),
  "version": "none",
  "difftool": new Set(["--no-prompt"]),
  "verify-pack": new Set(["v", "verbose", "s", "stat-only"]),
  "show-index": "none",
  "check-attr": new Set(["a", "all", "stdin", "z", "cached", "source"]),
  "interpret-trailers": new Set(["in-place", "parse", "only-trailers", "only-input", "unfold"]),
  "for-each-ref": new Set(["format", "sort", "count", "points-at", "merged", "no-merged", "contains", "shell", "python", "tcl", "perl"]),
};

/** 分词：处理引号，不做任何展开（展开相关写法已在别处拒绝） */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === "\\" && quote === '"') { i++; cur += segment[i] ?? ""; continue; }
      cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } }
    else if (c === "\\") { i++; cur += segment[i] ?? ""; }
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 取参数名：--max-depth=2 → max-depth；-rn → r */
const flagName = (tok: string) => tok.replace(/^--?/, "").split(/[=\s]/)[0].replace(/[^A-Za-z-].*$/, "");

/** 丢弃输出式的重定向（2>&1、>/dev/null）不算写文件 */
const stripRedirects = (s: string) =>
  s.replace(/\d?>&\d+/g, " ")                       // 2>&1、>&2：合并到已有描述符
   .replace(/\d?>>?\s*\/dev\/null\b/g, " ")        // 丢弃输出
   .replace(/\d?>>?\s*\/dev\/std(out|err)\b/g, " "); // 输出到标准流
/** 命令替换、进程替换、反引号：可以嵌套任意命令 */
const hasSubstitution = (s: string) => /\$\(|<\s*\(|\\`|`/.test(s);
/** 环境变量前缀可以覆盖分页程序、注入动态库 */
const hasEnvPrefix = (toks: string[]) => toks.some((t) => /^[A-Za-z_][\w.]*=/.test(t));

/** 允许作为位置参数的 git 引用样式（新建名字、远程地址都不符合） */
const GIT_POSITIONAL_OK = /^(HEAD|HEAD[~^][\d^~]+|[a-f0-9]{4,40}|origin\/[\w./-]+|refs\/[\w./-]+|tags\/[\w./-]+|remotes\/[\w./-]+|\*)$/;

function gitSafe(toks: string[]): boolean {
  const sub = toks[1];
  if (!sub) return false;
  const rule = GIT_READ[sub];
  if (!rule) return false;
  let rest = toks.slice(2);
  const dashdash = rest.indexOf("--");
  if (dashdash >= 0) rest = rest.slice(0, dashdash);              // -- 之后是路径，不参与参数校验
  if (rule === "none") return rest.length === 0;
  // 这些子命令带位置参数就是修改操作（新建分支/标签、增删远程）
  const LISTING_ONLY = new Set(["remote", "branch", "tag", "for-each-ref", "reflog"]);
  return rest.every((t) => {
    if (t.startsWith("-")) {
      if (/^-\d+$/.test(t)) return true;                        // git log -5
      return rule.has(flagName(t));
    }
    if (/[\\]/.test(t)) return false;
    if (LISTING_ONLY.has(sub)) return GIT_POSITIONAL_OK.test(t);
    return true;
  });
}

function segmentSafe(segment: string): boolean {
  const s = segment.trim();
  if (!s) return true;
  if (hasSubstitution(s)) return false;
  const cleaned = stripRedirects(s);
  if (/[<>`]/.test(cleaned)) return false;                      // 写文件的重定向、输入重定向
  const toks = tokenize(cleaned);
  if (hasEnvPrefix(toks)) return false;
  const cmd = toks[0];
  if (!cmd || /[^\w./-]/.test(cmd)) return false;
  if (cmd === "git") return gitSafe(toks);
  if (cmd.startsWith("./") || cmd.startsWith("/")) return false; // 直接执行程序
  const rule = SAFE[cmd];
  if (!rule) return false;
  const args = toks.slice(1);
  if (rule.noArgs) return args.length === 0;
  const positional = args.filter((a) => !a.startsWith("-") && a !== "--");
  if (cmd === "uniq" && positional.length > 1) return false;      // uniq 的第二個文件是输出目标
  const flags = rule.flags!;
  const longSingleDash = cmd === "find";                          // find 的 -name、-type 是单横线长参数
  for (const a of args) {
    if (!a.startsWith("-") || a === "-" || a === "--") continue;   // 路径、模式等位置参数
    if (/^-\d+$/.test(a)) continue;                                // -50：行数
    const name = flagName(a);
    if (!name || DANGEROUS.has(name)) return false;
    const shortNumeric = a.match(/^-([A-Za-z])(\d+)$/);            // -n5
    const single = !longSingleDash && a.match(/^-[A-Za-z]+$/);     // -rn = -r -n
    const ok = shortNumeric ? flags.has(shortNumeric[1])
      : single ? [...a.slice(1)].every((ch) => flags.has(ch))
      : flags.has(name);
    if (!ok) return false;
  }
  return true;
}

/** 整条命令是否只读 */
export function isReadOnlyCommand(command: string): boolean {
  if (isSensitivePath(command)) return false;                    // 读私钥、凭据也要经过同意
  const segments = stripRedirects(command).split(SEGMENT_SEP);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    if (/^cd(\s|$)/.test(s)) continue;
    if (!segmentSafe(s)) return false;
  }
  return true;
}

/** 拆分组合命令，返回需要审批的片段对应的键 */
export function commandKeys(command: string): string[] {
  const multi = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "python", "python3", "pip", "pip3", "node", "make", "docker", "kubectl", "brew", "swift", "xcodebuild", "ruby", "java", "gradle", "mvn"]);
  const keys: string[] = [];
  for (const seg of stripRedirects(command).split(SEGMENT_SEP)) {
    const s = seg.trim();
    if (!s || /^cd(\s|$)/.test(s) || isReadOnlyCommand(s)) continue;
    const toks = tokenize(stripRedirects(s));
    const cmd = toks.find((t) => !/^[A-Za-z_][\w.]*=/.test(t));
    if (!cmd) continue;
    const next = toks[toks.indexOf(cmd) + 1];
    keys.push(multi.has(cmd) && next && !next.startsWith("-") ? `${cmd} ${next}` : cmd);
  }
  return [...new Set(keys)];
}

const hasSideChannel = (command: string) => {
  const c = stripRedirects(command);
  return /[<>`]|\$\(|\\`/.test(c) || c.split(SEGMENT_SEP).some((s) => hasEnvPrefix(tokenize(s)));
};

/**
 * @param sandbox 命令沙箱是否开启。开启时沙箱内的命令在「自动编辑」「全自动」模式下自动运行；
 *                请求在沙箱外运行的命令无论什么模式都要用户批准。
 */
export function checkApproval(tool: Tool, args: Record<string, any>, mode: ApprovalMode, cwd: string, sessionAllowed: Set<string>, sandbox = false): ApprovalCheck {
  // 命令：先处理沙箱
  if (tool.kind === "exec") {
    const command = String(args.command ?? "");
    const unsandboxed = args.unsandboxed === true;
    if (sandbox && unsandboxed) {
      // 绕过沙箱是一次「提权」，即使全自动也要问；可以按命令记住
      const keys = commandKeys(command).map((k) => `unsandboxed:${k}`);
      const side = hasSideChannel(command);
      if (!side && keys.length && keys.every((k) => sessionAllowed.has(k))) return { needsApproval: false };
      const why = typeof args.justification === "string" && args.justification.trim() ? `：${args.justification.trim()}` : "";
      return { needsApproval: true, reason: `在沙箱外运行命令（可以联网、可以写工作区之外的文件）${why}`, sessionKey: side || !keys.length ? undefined : keys.join("\n") };
    }
    if (sandbox && mode !== "ask") return { needsApproval: false };
    if (mode === "full-auto") return { needsApproval: false };
    if (isReadOnlyCommand(command)) return { needsApproval: false };
    const keys = commandKeys(command).map((k) => `exec:${k}`);
    const side = hasSideChannel(command);
    if (!side && keys.length && keys.every((k) => sessionAllowed.has(k))) return { needsApproval: false };
    return { needsApproval: true, reason: sandbox ? "执行命令（在沙箱中）" : "执行命令", sessionKey: side || !keys.length ? undefined : keys.join("\n") };
  }

  if (mode === "full-auto") return { needsApproval: false };

  if (tool.kind === "read") {
    let file = "";
    try { file = resolvePath(cwd, args.path); } catch { return { needsApproval: false }; }
    const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
    if (!isSensitivePath(file) && !isSensitivePath(real)) return { needsApproval: false };
    const key = `read:${real}`;
    if (sessionAllowed.has(key)) return { needsApproval: false };
    return { needsApproval: true, reason: "读取敏感文件（可能包含密钥或凭据，内容会发送给模型）", sessionKey: key };
  }

  // write
  let file = "";
  try { file = resolvePath(cwd, args.path); } catch { return { needsApproval: false }; } // 参数错误交给工具自己报错
  // 解析符号链接后再判断，否则可以在工作区内建软链写到外面去
  const realCwd = fs.realpathSync(cwd);
  const real = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(realCwd, path.relative(cwd, file));
  const inside = isInside(realCwd, real);
  const inGitDir = path.relative(realCwd, real).split(path.sep)[0] === ".git"; // 改动会影响后续 git 操作
  const key = inside && !inGitDir ? "write:workspace" : `write:${real}`;
  if (sessionAllowed.has(key)) return { needsApproval: false };
  if (mode === "auto-edit" && inside && !inGitDir) return { needsApproval: false };
  return {
    needsApproval: true,
    reason: inGitDir ? "修改 .git 目录里的文件（会影响后续 git 操作）" : inside ? "修改文件" : "修改工作区之外的文件",
    sessionKey: key,
  };
}
