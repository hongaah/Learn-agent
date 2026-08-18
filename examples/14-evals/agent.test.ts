import { test, expect } from "bun:test";
import { runAgent } from "./index";

// LLM 的回答每次都不一样，所以断言只能针对"必须成立的事实"，
// 不能针对具体措辞。下面每一条都遵守这个原则。

const TIMEOUT = 120_000; // 真实 API 调用慢，默认 5 秒不够

test(
  "能答对 package.json 里的项目名",
  async () => {
    const trace = await runAgent("package.json 里 name 字段的值是什么？");
    // 断言事实，不断言措辞
    expect(trace.finalText).toContain("learn-agent");
    expect(trace.hitTurnLimit).toBe(false);
  },
  TIMEOUT,
);

test(
  "简单任务不该绕圈子",
  async () => {
    const trace = await runAgent("package.json 里 name 字段的值是什么？");
    // 这是 trajectory 断言：答案对不对是一回事，路径合不合理是另一回事
    expect(trace.rounds).toBeLessThanOrEqual(4);
    expect(trace.toolCalls.length).toBeLessThanOrEqual(3);
  },
  TIMEOUT,
);

test(
  "读文件的任务应该真的去读文件，而不是凭空编",
  async () => {
    const trace = await runAgent("examples/01-first-call/README.md 的第一行标题是什么？");
    // 一次工具都没调就给答案，说明它在编
    expect(trace.toolCalls.length).toBeGreaterThan(0);
    expect(trace.finalText).toContain("模型是无状态的");
  },
  TIMEOUT,
);

test(
  "工具报错之后要能自己恢复",
  async () => {
    const trace = await runAgent(
      "先读 no-such-file-xyz.txt，读不到的话改读 package.json，告诉我 name 字段。",
    );
    // 至少踩一次错，但最终仍然拿到正确结果
    expect(trace.toolCalls.some((c) => c.isError)).toBe(true);
    expect(trace.finalText).toContain("learn-agent");
    expect(trace.hitTurnLimit).toBe(false);
  },
  TIMEOUT,
);
