# Learn-agent 第二批（05–07 课）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 交付 L2 层两课（成本结构、流式与错误处理）和 L3 层第一课（工具设计）。

**Architecture:** 沿用 L1 已确立的形态——每课 `examples/NN-name/` 下自包含的 `index.ts` + 七节 README。

**依据：** `docs/superpowers/specs/2026-08-18-learn-agent-tutorial-design.md`
**风格样板：** `examples/01-first-call/README.md`（127 行那版）
**硬规则：** 见仓库根 `CLAUDE.md`，每个 task 都必须遵守，不再重复。

---

## Global Constraints

1. **模型 ID 只从 `process.env.MODEL_ID` 读**，不硬编码。
2. **主线代码只用** `model` / `max_tokens` / `messages` / `system` / `tools`（06 课额外用 `.stream()`，已实测可用）。
   `cache_control` / `thinking` / `output_config` / `betas` / `context_management` 一律只进第 6 节，带警示行：
   `> ⚠️ 本节需要 Anthropic 官方 key。第三方兼容端点大多不支持。`
3. **`max_tokens` 统一 16000**（探测类短请求可用小值，代码里要注明为什么）。
4. **README 固定七节 + 顶部两行元信息 + 第 2 节至少一张 mermaid 图。**
5. **写作风格照 `CLAUDE.md` 的「写作边界」**：段落≤3 句、结论前置、能列表就不用段落、
   第 3 节只贴要讲的片段。目标每课 130–160 行。
6. **去个人化**：实录里不许出现真实用户名和本机绝对路径，用 `user` / `/path/to/Learn-agent`。
7. **实录必须真跑**，禁止为跑通临时改 `index.ts`。跑法：
   `http_proxy= https_proxy= all_proxy= bun run examples/NN-xxx/index.ts`
8. 中文讲解 + 中文注释；术语首次出现给英文原词。
9. 每个 task 结束 commit，中文信息，`docs:` 前缀。

## 已实测的端点能力（写代码前必读）

| 能力 | 状态 | 影响 |
|---|---|---|
| `.stream()` 流式 | ✅ 可用，实测收到 200 个文本片段 | 06 课主线可真跑 |
| `BadRequestError` (400) | ✅ 缺 `max_tokens`、空 `messages` 都能触发 | 06 课错误分级可真跑 |
| 错误 API key | ⚠️ **不报错**，端点不校验 | 06 课演示不了 401，只能讲 |
| 未知模型名 | ⚠️ **不报错**，端点会 fallback | 06 课演示不了 404 |
| `cache_control` | ⚠️ 接受但 usage 中缓存字段被剥离 | 05 课**不能**用它演示，只能进第 6 节 |
| `count_tokens` | ❌ 404 不可用 | 05 课改用 `input_tokens` 差值法 |

---

### Task 1: 05-context-cost —— 上下文的成本结构

**Files:**
- Create: `examples/05-context-cost/index.ts`
- Create: `examples/05-context-cost/README.md`

**课名说明：** 目录叫 `05-context-cost` 而不是 `05-prompt-caching`。
因为缓存效果在兼容端点上不可观测，这一课主线讲的是**成本结构**（通用架构知识），
缓存是它的解法之一，放第 6 节。这样不承诺跑不出来的东西。

**教学目标：** 让读者看到 agent 每轮到底在重复发送什么、占比多少。

- [ ] **Step 1: 写 index.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;

// 模拟一个真实 agent 的系统提示词——真实项目里这段通常几百到几千 token
const SYSTEM = `你是一个在当前目录工作的编码助手。

## 工作原则
- 优先使用工具，不要凭猜测回答。
- 修改文件前先读一遍，确认当前内容。
- 每完成一步，用一句话说明你做了什么。

## 工具使用
- bash 用来执行命令，read_file 用来读文件，write_file 用来写文件。
- 需要了解目录结构时用 bash 执行 ls，不要猜测文件是否存在。
- 写文件会覆盖原有内容，写之前务必先确认。

## 回答风格
- 简洁，不要复述用户的问题。
- 不确定的时候直接说不确定，不要编造。`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "在当前目录执行一条 shell 命令，返回它的输出。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的 shell 命令" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取一个文件的全部内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "把内容写入一个文件，覆盖原有内容。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["path", "content"],
    },
  },
];

// ============ 第一部分：一次请求的成本由什么构成 ============
//
// 这个端点不支持 count_tokens 接口，所以用差值法：
// 发三次几乎一样的请求，每次多带一个部分，用 input_tokens 的差就是那部分的开销。
// max_tokens 给 8 是因为我们只关心输入，不需要模型多说话。

async function breakdown() {
  const question: Anthropic.MessageParam = { role: "user", content: "hi" };

  const bare = await client.messages.create({
    model: MODEL, max_tokens: 8, messages: [question],
  });
  const withSystem = await client.messages.create({
    model: MODEL, max_tokens: 8, system: SYSTEM, messages: [question],
  });
  const withAll = await client.messages.create({
    model: MODEL, max_tokens: 8, system: SYSTEM, tools: TOOLS, messages: [question],
  });

  const q = bare.usage.input_tokens;
  const sys = withSystem.usage.input_tokens - q;
  const tools = withAll.usage.input_tokens - withSystem.usage.input_tokens;
  const total = withAll.usage.input_tokens;

  console.log("一次请求的 input_tokens 由三部分组成：\n");
  console.log(`  你的问题          ${String(q).padStart(5)} tokens`);
  console.log(`  system 提示词    +${String(sys).padStart(5)} tokens`);
  console.log(`  工具定义         +${String(tools).padStart(5)} tokens`);
  console.log(`  ${"-".repeat(32)}`);
  console.log(`  合计              ${String(total).padStart(5)} tokens\n`);
  console.log(`  固定开销 ${sys + tools} tokens，是问题本身的 ${Math.round((sys + tools) / q)} 倍。`);
  console.log(`  而且每一轮都要原样重发一次。\n`);
}

// ============ 第二部分：多轮下来，重复发了多少 ============

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_file: async ({ path }) => await Bun.file(path).text(),
  write_file: async ({ path, content }) => {
    await Bun.write(path, content);
    return `已写入 ${path}`;
  },
};

async function multiRound(task: string) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const perRound: number[] = [];

  for (let turn = 1; turn <= 20; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 16000, system: SYSTEM, messages, tools: TOOLS,
    });
    perRound.push(res.usage.input_tokens);
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const handler = toolHandlers[block.name];
      let output: string;
      try {
        output = handler ? await handler(block.input) : `错误：没有名为 ${block.name} 的工具`;
      } catch (e: any) {
        output = `错误：${e.message}`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }

  // 第 N 轮发出去的内容里，有「第 N-1 轮发过的那么多」是重复的。
  // 所以累计重复量就是把除最后一轮外的每轮 input_tokens 加起来。
  const sent = perRound.reduce((a, b) => a + b, 0);
  const repeated = perRound.slice(0, -1).reduce((a, b) => a + b, 0);

  console.log(`跑了 ${perRound.length} 轮，每轮 input_tokens：`);
  perRound.forEach((t, i) => {
    console.log(`  第 ${String(i + 1).padStart(2)} 轮  ${String(t).padStart(6)}`);
  });
  console.log(`\n  累计发送   ${sent} tokens`);
  console.log(`  其中重复   ${repeated} tokens（${Math.round((repeated / sent) * 100)}%）`);
  console.log(`  真正新增   ${sent - repeated} tokens\n`);
}

await breakdown();
await multiRound(
  "统计当前目录下有多少个 .ts 文件，再看看 package.json 里声明了哪些依赖，最后把这两个结论告诉我。",
);
```

- [ ] **Step 2: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/05-context-cost/index.ts
```

Expected：先打印三行成本构成（固定开销应该是问题本身的几十倍），
再打印多轮表格和重复率（预期 60% 以上）。保存完整输出。

- [ ] **Step 3: 写 README.md**

七节。要点：

- **第 1 节**：03 课看到 token 一轮轮涨，但没说清涨的是什么。这一课把账拆开。
- **第 2 节**：mermaid `flowchart`，画一次请求的三段构成（tools → system → messages），
  标出前两段每轮完全相同。**渲染顺序 tools → system → messages 要画对**，
  这是第 6 节讲缓存前缀的基础。
- **第 3 节**：讲差值法（为什么不用 count_tokens：这个端点 404），讲重复量的算法。
- **第 4 节**：贴真实输出，点评固定开销倍数和重复率。
- **第 5 节**：重复发送不可避免——API 无状态，这是第 01 课的直接后果。能做的是两件事：
  让重复部分变便宜（缓存，第 6 节）、让历史别无限变长（压缩，第 08 课）。
- **第 6 节**：`cache_control` 用法 + 三条前缀稳定性规则：
  渲染顺序是 `tools` → `system` → `messages`；前缀任何字节变化都让后面全失效；
  时间戳/随机 ID 这类易变内容必须放在最后一个缓存断点之后。
  验证命中看 `usage.cache_read_input_tokens`。
  **明确说明**：很多第三方端点会剥离这些 usage 字段，所以本课主线没法演示效果。
- **第 7 节**：相比 03 课，这一课没有新机制，只是把账算清楚了。

- [ ] **Step 4: 校验并提交**

```bash
grep -c '^## [1-7]\.' examples/05-context-cost/README.md   # 应为 7
grep -c '```mermaid' examples/05-context-cost/README.md     # 应 ≥1
bunx tsc --noEmit
git add examples/05-context-cost && git commit -m "docs: 05 课 上下文的成本结构"
```

---

### Task 2: 06-streaming-errors —— 流式输出与错误处理

**Files:**
- Create: `examples/06-streaming-errors/index.ts`
- Create: `examples/06-streaming-errors/README.md`

**教学目标：** 两件让 agent 能用于真实场景的事——别让用户干等，别让一个错误崩掉整个循环。

- [ ] **Step 1: 写 index.ts**

```ts
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
```

- [ ] **Step 2: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/06-streaming-errors/index.ts
```

Expected：流式部分逐字冒出内容并给出首字节耗时；错误部分两个用例都识别成
`BadRequestError (400) 可重试=false`；重试部分一次就放弃。

- [ ] **Step 3: 写 README.md**

七节。要点：

- **第 1 节**：两个真实场景——长回复用户干等十几秒；一次限流让整个 agent 循环崩掉。
- **第 2 节**：mermaid `flowchart`，画错误分级的判断链：
  异常 → 是不是 400/401/404（不可重试，直接抛）→ 是不是 429/连接错误/5xx（可重试，指数退避）。
- **第 3 节**：三段。`stream.on("text")` + `finalMessage()`；
  `classify()` 为什么必须从具体到宽泛判断（`RateLimitError` 也是 `APIError`，顺序反了就全被当成可重试）；
  `withRetry` 为什么先判可重试再等待。
- **第 4 节**：贴真实输出。点评首字节耗时 vs 总耗时的差距。
- **第 5 节**：**必须诚实说明**——这一课只演示了 400 这一类。
  401 和 404 演示不出来，因为很多兼容端点不校验 key、遇到未知模型名会 fallback 到默认模型。
  分级代码本身是对的，换成官方端点就能触发全部分支。
  另外：真实生产还需要总超时和熔断，这一课没有。
- **第 6 节**：官方 SDK 自带重试（`maxRetries` 默认 2，覆盖 408/409/429/5xx 和连接错误），
  以及 `timeout` 的单位陷阱——TypeScript SDK 用毫秒，Python 用秒。
  超时也会被重试，所以最坏耗时是 `timeout × (maxRetries + 1)`。
- **第 7 节**：相比前面的课，请求参数没变，变的是**怎么发和怎么收**。

- [ ] **Step 4: 校验并提交**

```bash
grep -c '^## [1-7]\.' examples/06-streaming-errors/README.md
grep -c '```mermaid' examples/06-streaming-errors/README.md
bunx tsc --noEmit
git add examples/06-streaming-errors && git commit -m "docs: 06 课 流式输出与错误处理"
```

---

### Task 3: 07-tool-design —— 工具设计

**Files:**
- Create: `examples/07-tool-design/index.ts`
- Create: `examples/07-tool-design/README.md`

**教学目标：** 让读者亲眼看到工具集设计如何影响 agent 的表现。
**这一课没有新 API**，全是设计判断，但它是整套教程里最能提升实战效果的一课。

**核心论点（官方指导）：** 如果人类工程师都说不清某个场景该用哪个工具，agent 更不可能做对。

- [ ] **Step 1: 写 index.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 15;

// ============ 两套工具集，同一个任务 ============

// 臃肿版：8 个工具，职责互相重叠。
// 这不是杜撰——真实项目里工具是一个个加上去的，加着加着就成了这样。
const BLOATED: Anthropic.Tool[] = [
  { name: "read_file", description: "读取文件内容。",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "cat_file", description: "查看一个文件。",
    input_schema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } },
  { name: "read_lines", description: "读取文件的指定行范围。",
    input_schema: { type: "object", properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["path"] } },
  { name: "view_file", description: "显示文件内容，带行号。",
    input_schema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
  { name: "list_dir", description: "列出目录下的文件。",
    input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] } },
  { name: "find_files", description: "按名字查找文件。",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "search_text", description: "在文件里搜索文本。",
    input_schema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"] } },
  { name: "grep", description: "用 grep 搜索。",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
];

// 精简版：3 个工具，职责不重叠，边界清楚
const FOCUSED: Anthropic.Tool[] = [
  { name: "bash", description: "在当前目录执行一条 shell 命令，返回它的输出。适合列目录、搜索、统计这类事。",
    input_schema: { type: "object", properties: { command: { type: "string", description: "要执行的 shell 命令" } }, required: ["command"] } },
  { name: "read_file", description: "读取一个文件的全部内容。只在需要完整内容时用；只想找某几行就用 bash 跑 grep。",
    input_schema: { type: "object", properties: { path: { type: "string", description: "文件路径" } }, required: ["path"] } },
  { name: "write_file", description: "把内容写入一个文件，覆盖原有内容。",
    input_schema: { type: "object", properties: { path: { type: "string", description: "文件路径" }, content: { type: "string", description: "要写入的完整内容" } }, required: ["path", "content"] } },
];

// 两套工具都用同一批实现——这一课比的是"怎么描述工具"，不是"工具怎么实现"
async function execute(name: string, input: any): Promise<string> {
  const run = async (cmd: string) => {
    const r = await Bun.$`sh -c ${cmd}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  };
  switch (name) {
    case "bash": return run(input.command);
    case "read_file": return await Bun.file(input.path).text();
    case "cat_file": return await Bun.file(input.filename).text();
    case "view_file": return await Bun.file(input.file).text();
    case "read_lines": return run(`sed -n '${input.start ?? 1},${input.end ?? 40}p' ${input.path}`);
    case "list_dir": return run(`ls -1 ${input.dir}`);
    case "find_files": return run(`find . -name '${input.pattern}' -not -path './node_modules/*'`);
    case "search_text": return run(`grep -rn '${input.query}' ${input.path ?? "."} | head -20`);
    case "grep": return run(`grep -rn '${input.pattern}' ${input.path ?? "."} | head -20`);
    case "write_file": { await Bun.write(input.path, input.content); return `已写入 ${input.path}`; }
    default: return `错误：没有名为 ${name} 的工具`;
  }
}

// 跑同一个任务，记录用了几轮、调了哪些工具
async function runWith(label: string, tools: Anthropic.Tool[], task: string) {
  console.log(`\n${"=".repeat(46)}`);
  console.log(`${label}（${tools.length} 个工具）`);
  console.log("=".repeat(46));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const called: string[] = [];
  let firstInput = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, messages, tools,
    });
    if (turn === 1) firstInput = res.usage.input_tokens;
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      console.log(`\n  轮数：${turn}`);
      console.log(`  工具调用序列：${called.join(" → ") || "（没调用工具）"}`);
      console.log(`  首轮 input_tokens：${firstInput}（其中工具定义占大头）`);
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      called.push(block.name);
      console.log(`  第 ${turn} 轮 → ${block.name}(${JSON.stringify(block.input).slice(0, 60)})`);
      let output: string;
      try {
        output = await execute(block.name, block.input);
      } catch (e: any) {
        output = `错误：${e.message}`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output.slice(0, 2000) });
    }
    messages.push({ role: "user", content: results });
  }
  console.log(`  达到 ${MAX_TURNS} 轮上限`);
}

const TASK = "package.json 里声明了哪些依赖？告诉我依赖名字就行。";

await runWith("臃肿工具集", BLOATED, TASK);
await runWith("精简工具集", FOCUSED, TASK);
```

- [ ] **Step 2: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/07-tool-design/index.ts
```

Expected：两套工具集都能完成任务，但**首轮 input_tokens 差距明显**（臃肿版工具定义更占地方）。
工具选择序列可能也有差异。

**重要：这一课的结果有不确定性。** 模型可能在臃肿版里也选对工具。
**如实记录跑出来的结果**，不要为了论点好看而反复重跑挑一个"好看的"。
如果臃肿版表现同样好，就在 README 里诚实写出来，并指出真正确定的代价是
token 开销和可维护性——这本身也是一个有价值的结论。

- [ ] **Step 3: 写 README.md**

七节。要点：

- **第 1 节**：真实项目的工具是一个个加上去的，加到第 8 个的时候，
  `read_file`、`cat_file`、`view_file`、`read_lines` 同时存在，谁也说不清该用哪个。
- **第 2 节**：mermaid，画模型面对重叠工具时的选择困境。
- **第 3 节**：对比两套工具的 `description` 写法。精简版的 `read_file` 描述里
  写了"只想找某几行就用 bash 跑 grep"——**主动划清边界**，这是关键技巧。
- **第 4 节**：贴真实输出，对比首轮 token 和调用序列。
- **第 5 节**：工具设计三条：
  1. **职责不重叠。** 判断标准就是官方那句话：人类工程师说不清该用哪个，agent 更不可能做对。
  2. **description 是给模型看的唯一说明。** 参数名要自解释，边界要写进描述。
  3. **工具定义每轮都重发**（第 05 课算过账），8 个工具比 3 个贵，而且贵在每一轮。
- **第 6 节**：官方的 tool search——工具多到一定程度时，把大部分工具标 `defer_loading: true`，
  让模型先搜索再加载。这是"工具太多"的工程解，但**先做减法，再上工具搜索**。
- **第 7 节**：这一课没有新 API，`index.ts` 里唯一的新东西是同一任务跑两遍做对照。

**另外**：这一课要顺带讲系统提示词的 altitude（高度）——
既不要写成一堆 if-else 硬规则（脆而不通用），也不要空泛到没有指导性。
放在第 5 节末尾，两三句话，给一个好例子和一个坏例子。

- [ ] **Step 4: 校验并提交**

```bash
grep -c '^## [1-7]\.' examples/07-tool-design/README.md
grep -c '```mermaid' examples/07-tool-design/README.md
bunx tsc --noEmit
git add examples/07-tool-design && git commit -m "docs: 07 课 工具设计"
```

---

### Task 4: 更新根 README 路线图

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 把 05/06/07 三行从「规划中」改成已完成**

同时更新链接指向真实目录。注意 05 课的标题是「上下文的成本结构」，
不是原路线图里写的「prompt caching」——课名变了，表格里的描述也要跟着改。

- [ ] **Step 2: 更新路线图 mermaid 图**，把 05–07 标成已完成的样式

- [ ] **Step 3: 校验并提交**

```bash
for d in 05-context-cost 06-streaming-errors 07-tool-design; do
  test -d "examples/$d" && echo "$d ✓" || echo "$d ✗"
done
git add README.md && git commit -m "docs: 路线图更新 05–07 课状态"
```

---

## 完成标准

- [ ] 三课各有 `index.ts` + `README.md`，README 七节齐全、至少一张 mermaid 图
- [ ] 三课都能真跑：`http_proxy= https_proxy= all_proxy= bun run examples/NN-xxx/index.ts`
- [ ] 每课 README 第 4 节贴的是真实输出
- [ ] `bunx tsc --noEmit` 零错误
- [ ] 全仓库无个人信息：`grep -rn 'yangjie\|/Users/yangjie' examples/ README.md` 无输出
- [ ] 无硬编码模型名：`grep -rn 'ugreen-ai-model\|claude-opus-5' examples/*/index.ts` 无输出
- [ ] 根 README 路线图已更新
