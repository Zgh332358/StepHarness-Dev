// API Key 的存储。
//   macOS：系统钥匙串（Keychain），通过系统自带的 /usr/bin/security 读写。
//          写入时命令走标准输入，Key 不会出现在进程参数列表里。
//   其他系统：~/.stepharness/secrets.json（权限 600）。
// Key 永远不会写进 config.json，也不会传给界面进程。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

const SECURITY = "/usr/bin/security";
/** 钥匙串里的服务名；测试时可以用环境变量换成别的，避免影响真实数据 */
const service = () => process.env.STEPHARNESS_KEYCHAIN_SERVICE || "StepHarness";
const useKeychain = () => process.platform === "darwin" && fs.existsSync(SECURITY) && process.env.STEPHARNESS_SECRETS !== "file";
const secretsFile = () => path.join(dataDir(), "secrets.json");

// 钥匙串会把含非 ASCII 字符的密码以十六进制输出，和本身就是十六进制的 Key 无法区分。
// 所以统一存成 "b64:" + Base64，读出来再解码。
const encode = (key: string) => "b64:" + Buffer.from(key, "utf8").toString("base64");
const decode = (stored: string) => (stored.startsWith("b64:") ? Buffer.from(stored.slice(4), "base64").toString("utf8") : stored);
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function readFileSecrets(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(secretsFile(), "utf8")); } catch { return {}; }
}
function writeFileSecrets(all: Record<string, string>) {
  fs.mkdirSync(path.dirname(secretsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretsFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(secretsFile(), 0o600);
}

export function getSecret(providerId: string): string | undefined {
  if (!useKeychain()) return readFileSecrets()[providerId] || undefined;
  const r = spawnSync(SECURITY, ["find-generic-password", "-s", service(), "-a", providerId, "-w"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const v = decode(r.stdout.replace(/\n$/, ""));
  return v || undefined;
}

export function setSecret(providerId: string, key: string): void {
  const value = key.trim();
  if (!value) throw new Error("API Key 不能为空");
  if (/[\r\n]/.test(value)) throw new Error("API Key 不能包含换行");
  if (!useKeychain()) { writeFileSecrets({ ...readFileSecrets(), [providerId]: value }); return; }
  const cmd = `add-generic-password -U -s ${quote(service())} -a ${quote(providerId)} -l ${quote(`StepHarness: ${providerId}`)} -w ${quote(encode(value))}\n`;
  const r = spawnSync(SECURITY, ["-i"], { input: cmd, encoding: "utf8" });
  if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`写入钥匙串失败：${(r.stderr || "").trim() || r.status}`);
}

export function deleteSecret(providerId: string): void {
  if (!useKeychain()) { const all = readFileSecrets(); delete all[providerId]; writeFileSecrets(all); return; }
  spawnSync(SECURITY, ["delete-generic-password", "-s", service(), "-a", providerId], { encoding: "utf8" });
}

export const secretStoreName = () => (useKeychain() ? "macOS 钥匙串" : "~/.stepharness/secrets.json");
