import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;

// ============ 第一部分：流式输出 ============
//
// 非流式调用要等模型把整段话生成完才返回，长回复能等十几秒。
// 流式是边生成边推给你，用户立刻看到字往外冒。

async function streaming() {
  console.log("=== 流式输出 ===\n");

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: "用三句话解释什么是 agent 循环。" }],
  });

  let chunks = 0;
  const started = performance.now();
  let firstChunkAt = 0;

  stream.on("text", (text) => {
    if (chunks === 0) firstChunkAt = performance.now() - started;
    chunks++;
    process.stdout.write(text); // 逐片打印，不等全部生成完
  });

  // finalMessage() 等流结束，返回和非流式一样的完整 Message 对象
  const final = await stream.finalMessage();
  const total = performance.now() - started;

  console.log(`\n\n  收到 ${chunks} 个片段`);
  console.log(`  首字节耗时 ${firstChunkAt.toFixed(0)}ms，全部完成 ${total.toFixed(0)}ms`);
  console.log(`  stop_reason=${final.stop_reason}，输出 ${final.usage.output_tokens} tokens`);
  console.log(`\n  用户从第 ${firstChunkAt.toFixed(0)}ms 就开始看到内容，而不是干等 ${total.toFixed(0)}ms。\n`);
}

// ============ 第二部分：错误要分级 ============
//
// 不是所有错误都该重试。400 是你请求写错了，重试一百次还是错；
// 429 和 5xx 是暂时性的，等一下再试就好。

type Verdict = { kind: string; retryable: boolean; detail: string };

function classify(e: unknown): Verdict {
  // 从最具体到最宽泛地判断，顺序不能反——RateLimitError 也是 APIError
  if (e instanceof Anthropic.BadRequestError)
    return { kind: "BadRequestError (400)", retryable: false, detail: "请求本身写错了，重试无用" };
  if (e instanceof Anthropic.AuthenticationError)
    return { kind: "AuthenticationError (401)", retryable: false, detail: "key 不对，重试无用" };
  if (e instanceof Anthropic.NotFoundError)
    return { kind: "NotFoundError (404)", retryable: false, detail: "模型名或路径不存在" };
  if (e instanceof Anthropic.RateLimitError)
    return { kind: "RateLimitError (429)", retryable: true, detail: "被限流，等一下重试" };
  if (e instanceof Anthropic.APIConnectionError)
    return { kind: "APIConnectionError", retryable: true, detail: "网络问题，可以重试" };
  if (e instanceof Anthropic.APIError)
    return { kind: `APIError (${(e as any).status})`, retryable: true, detail: "服务端异常，可以重试" };
  return { kind: "未知错误", retryable: false, detail: String(e) };
}

async function errorHandling() {
  console.log("=== 错误分级 ===\n");

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["缺少 max_tokens", () =>
      client.messages.create({ model: MODEL, messages: [{ role: "user", content: "hi" }] } as any)],
    ["messages 是空数组", () =>
      client.messages.create({ model: MODEL, max_tokens: 16, messages: [] })],
  ];

  for (const [label, fn] of cases) {
    try {
      await fn();
      console.log(`  ${label}: 居然没报错`);
    } catch (e) {
      const v = classify(e);
      console.log(`  ${label}`);
      console.log(`    → ${v.kind}  可重试=${v.retryable}  ${v.detail}`);
    }
  }
  console.log();
}

// ============ 第三部分：只对可重试的错误做指数退避 ============

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const v = classify(e);

      // 不可重试的错误立刻抛出，不要浪费时间
      if (!v.retryable) {
        console.log(`  第 ${attempt} 次失败：${v.kind}，不可重试，直接放弃`);
        throw e;
      }

      // 等待时间翻倍：1s、2s、4s……
      const waitMs = 1000 * 2 ** (attempt - 1);
      console.log(`  第 ${attempt} 次失败：${v.kind}，${waitMs}ms 后重试`);
      await Bun.sleep(waitMs);
    }
  }
  throw lastError;
}

async function retryDemo() {
  console.log("=== 重试策略 ===\n");
  console.log("  对一个不可重试的错误调用 withRetry：");
  try {
    await withRetry(() => client.messages.create({ model: MODEL, max_tokens: 16, messages: [] }));
  } catch {
    console.log("  → 一次就放弃了，没有做无谓的等待\n");
  }
}

await streaming();
await errorHandling();
await retryDemo();
