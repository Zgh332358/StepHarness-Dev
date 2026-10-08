// 打包成 macOS 应用：release/StepHarness.app
// 做法：复制 Electron.app，替换名称、图标，把构建产物放进 Resources/app，最后做一次本地签名。
import { execFileSync } from "node:child_process";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") { console.error("目前只支持在 macOS 上打包"); process.exit(1); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const NAME = pkg.productName || "StepHarness";
const src = path.join(root, "node_modules/electron/dist/Electron.app");
const out = path.join(root, "release", `${NAME}.app`);
const plist = path.join(out, "Contents/Info.plist");
const res = path.join(out, "Contents/Resources");
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
sh("ditto", [src, out]); // ditto 会正确保留 Frameworks 里的符号链接

// 名称、标识、图标
for (const [key, val] of [["CFBundleName", NAME], ["CFBundleDisplayName", NAME], ["CFBundleIdentifier", "dev.stepharness.app"],
  ["CFBundleShortVersionString", pkg.version], ["CFBundleVersion", pkg.version], ["CFBundleIconFile", "icon.icns"]]) {
  sh("plutil", ["-replace", key, "-string", val, plist]);
}
fs.copyFileSync(path.join(root, "assets/icon.icns"), path.join(res, "icon.icns"));
fs.rmSync(path.join(res, "electron.icns"), { force: true });
fs.rmSync(path.join(res, "default_app.asar"), { force: true });

// 应用代码
const appDir = path.join(res, "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: pkg.name, productName: NAME, version: pkg.version, main: "dist/main.js" }, null, 2));
fs.cpSync(path.join(root, "dist"), path.join(appDir, "dist"), { recursive: true, filter: (f) => !f.endsWith(".map") });

// 关闭不需要的 Electron 能力，防止别的程序借用 StepHarness 的身份执行代码
await flipFuses(path.join(out, "Contents/MacOS/Electron"), {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,                         // 禁止 ELECTRON_RUN_AS_NODE 把应用当 node 用
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // 忽略 NODE_OPTIONS（可注入 --require）
  [FuseV1Options.EnableNodeCliInspectArguments]: false,     // 禁止 --inspect 附加调试器
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,  // file:// 不给额外权限
});

// 修改了 bundle 内容，需要重新做本地（ad-hoc）签名，否则 Apple Silicon 上无法启动
sh("codesign", ["--force", "--deep", "--sign", "-", out]);
const size = sh("du", ["-sh", out]).split("\t")[0];
console.log(`打包完成 → ${out}（${size}）`);
