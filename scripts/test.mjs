// 测试入口：用 esbuild 打包后运行。
//   npm test                 单元测试 + 安全测试（不联网）
//   npm run test:live        额外运行真实模型的集成测试（会产生少量费用）
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const live = process.argv.includes("--live");
const files = ["unit", "security", "agent", ...(live ? ["integration"] : [])];
const entry = path.join("test", ".entry.ts");
fs.writeFileSync(entry, files.map((f) => `import "./${f}.test.js";`).join("\n") + `\nimport { run } from "./harness.js";\nrun().then((f) => process.exit(f ? 1 : 0));\n`);
await build({
  entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: "test/.out/run.cjs", logLevel: "warning", target: "node20",
  // 把源码文本内联进去，安全测试里做静态检查时用
  define: {
    __MAIN_SRC__: JSON.stringify(fs.readFileSync("src/main/main.ts", "utf8")),
    __RENDERER_HTML__: JSON.stringify(fs.readFileSync("src/renderer/index.html", "utf8")),
    __PRELOAD_SRC__: JSON.stringify(fs.readFileSync("src/main/preload.ts", "utf8")),
    __CONFIG_SRC__: JSON.stringify(fs.readFileSync("src/core/config.ts", "utf8")),
  },
});
fs.rmSync(entry);

// 离线测试：独立的数据目录 + 文件方式保存 Key，完全不碰你的真实配置和钥匙串。
// 联网测试：使用你自己的配置（~/.stepharness）和钥匙串里的 Key，模型由 STEPHARNESS_TEST_MODELS 指定。
const home = live ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "stepharness-test-home-"));
const env = live ? { ...process.env } : { ...process.env, STEPHARNESS_HOME: home, STEPHARNESS_SECRETS: "file" };
const r = spawnSync(process.execPath, ["test/.out/run.cjs"], { stdio: "inherit", env });
if (home) fs.rmSync(home, { recursive: true, force: true });
process.exit(r.status ?? 1);
