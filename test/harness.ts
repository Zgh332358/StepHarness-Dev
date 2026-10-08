// 极简测试框架（不引入依赖）
type Fn = () => void | Promise<void>;
const tests: { group: string; name: string; fn: Fn }[] = [];
let group = "";

export function describe(name: string, fn: () => void) { group = name; fn(); group = ""; }
export function test(name: string, fn: Fn) { tests.push({ group, name, fn }); }
export function expect(cond: unknown, msg = "断言失败"): asserts cond { if (!cond) throw new Error(msg); }
export function eq<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n    期望: ${e}\n    实际: ${a}`);
}

export async function run() {
  const filter = process.env.TEST_FILTER;
  let pass = 0, fail = 0, last = "";
  for (const t of tests) {
    if (filter && !`${t.group} ${t.name}`.includes(filter)) continue;
    if (t.group !== last) { console.log(`\n\x1b[1m${t.group}\x1b[0m`); last = t.group; }
    const t0 = Date.now();
    try {
      await t.fn();
      pass++;
      const ms = Date.now() - t0;
      console.log(`  \x1b[32m✓\x1b[0m ${t.name}${ms > 1500 ? ` \x1b[2m(${(ms / 1000).toFixed(1)}s)\x1b[0m` : ""}`);
    } catch (err) {
      fail++;
      console.log(`  \x1b[31m✗ ${t.name}\x1b[0m\n    ${(err as Error).message}`);
    }
  }
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} 通过，${fail} 失败\x1b[0m`);
  return fail;
}
