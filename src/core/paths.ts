import os from "node:os";
import path from "node:path";

/** 数据目录。用函数而不是常量，方便测试时通过环境变量切换 */
export const dataDir = () => process.env.STEPHARNESS_HOME || path.join(os.homedir(), ".stepharness");
