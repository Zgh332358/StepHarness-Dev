// 用 esbuild 打包：主进程、preload、渲染进程、命令行
import { build } from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
fs.mkdirSync("dist/renderer", { recursive: true });

const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2022" };
await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/main/preload.ts"], outfile: "dist/preload.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/app.ts"], outfile: "dist/renderer/app.js", platform: "browser", format: "iife" }), // 经典脚本：file:// 不再有额外权限时 ES module 无法加载
  build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.mjs", platform: "node", format: "esm" }),
]);
for (const f of ["index.html", "style.css"]) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
console.log("构建完成 → dist/");
void watch;
