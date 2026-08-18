# Learn-agent 第四批（11、12、14 课）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 `- [ ]`。

**Goal:** 交付 11 subagent、12 后台任务、14 evals。13 课（MCP）单独一批。

**依据：** `docs/superpowers/specs/2026-08-18-learn-agent-tutorial-design.md`
**风格样板：** `examples/01-first-call/README.md`
**硬规则：** 仓库根 `CLAUDE.md`。

---

## Global Constraints

1. 模型 ID 只从 `process.env.MODEL_ID` 读。
2. 主线代码只用 `model` / `max_tokens` / `messages` / `system` / `tools`。
   beta 特性只进第 6 节，带警示行：
   `> ⚠️ 本节需要 Anthropic 官方 key。第三方兼容端点大多不支持。`
3. `max_tokens` 统一 16000。
4. README 七节 + 顶部两行元信息 + 第 2 节至少一张 mermaid 图，目标 130–170 行。
5. 写作照 `CLAUDE.md` 的「写作边界」。
6. 去个人化：实录不许出现真实用户名和本机绝对路径。
7. 实录必须真跑，禁止为跑通改 `index.ts`。跑法：
   `http_proxy= https_proxy= all_proxy= bun run examples/NN-xxx/index.ts`
8. 中文讲解 + 中文注释。

---

### Task 1: 11-subagent —— 子代理

**Files:** `examples/11-subagent/index.ts`、`README.md`

**教学目标：** 一次大搜索会把主上下文塞满垃圾。解法是派个子代理去做，
它有独立的消息历史，干完只回一段摘要——**脏活留在它那边**。

**演示设计：同一任务跑两遍**，A 主 agent 自己读所有文件，B 派子代理去读，
对比**主上下文**的最终大小。这是这一课唯一有说服力的指标。

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
const SUBAGENT_MAX_TURNS = 12;

// ---- 基础工具，主 agent 和子代理都能用 ----
const BASE_TOOLS: Anthropic.Tool[] = [
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
];

// ---- 派生子代理的工具，只有主 agent 有 ----
const AGENT_TOOL: Anthropic.Tool = {
  name: "agent",
  description:
    "派一个子代理去完成一件独立的调查任务。它有自己的上下文，看不到我们的对话，" +
    "干完只会回一段摘要。适合那种要翻很多文件、但你只需要结论的活。",
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "交给子代理的完整任务描述，它看不到上下文，要写清楚" },
    },
    required: ["prompt"],
  },
};

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_file: async ({ path }) => await Bun.file(path).text(),
};

// ============ 子代理：独立上下文，收窄工具集 ============
//
// 注意它的 tools 是 BASE_TOOLS，不含 AGENT_TOOL——
// 子代理不能再派子代理，否则可能无限递归下去。

async function runSubagent(prompt: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let lastResponse: Anthropic.Message | undefined;
  let innerTokens = 0;

  for (let turn = 0; turn < SUBAGENT_MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: "你是一个调查子代理。完成任务后，用简洁的话总结你的发现，不要罗列原始内容。",
      messages,
      tools: BASE_TOOLS,
    });
    innerTokens += res.usage.input_tokens;
    messages.push({ role: "assistant", content: res.content });
    lastResponse = res;

    if (res.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      console.log(`      [子代理] ${block.name}(${JSON.stringify(block.input).slice(0, 50)})`);
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

  const summary =
    lastResponse?.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("") || "(子代理没有产出摘要)";

  console.log(`      [子代理] 内部消耗 ${innerTokens} tokens，回传摘要 ${summary.length} 字符`);
  return summary;
}

// ============ 主 agent ============

async function runMain(label: string, tools: Anthropic.Tool[], task: string) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const perRound: number[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, messages, tools,
    });
    perRound.push(res.usage.input_tokens);
    console.log(`  第 ${String(turn).padStart(2)} 轮  主上下文 input=${res.usage.input_tokens}`);
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;

      let output: string;
      if (block.name === "agent") {
        console.log(`    → 派出子代理`);
        output = await runSubagent((block.input as any).prompt);
      } else {
        console.log(`    → ${block.name}(${JSON.stringify(block.input).slice(0, 50)})`);
        const handler = toolHandlers[block.name];
        try {
          output = handler ? await handler(block.input) : `错误：没有名为 ${block.name} 的工具`;
        } catch (e: any) {
          output = `错误：${e.message}`;
        }
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }

  const peak = Math.max(...perRound);
  console.log(`  —— ${perRound.length} 轮，主上下文峰值 ${peak}`);
  return { rounds: perRound.length, peak };
}

const TASK =
  "看一下 examples 目录下每一课的 README.md，告诉我哪一课最长、哪一课最短，只要课名和行数。";

const direct = await runMain("A · 主 agent 自己动手", BASE_TOOLS, TASK);
const delegated = await runMain("B · 派给子代理", [...BASE_TOOLS, AGENT_TOOL], TASK);

console.log(`\n${"=".repeat(46)}\n对比\n${"=".repeat(46)}`);
console.log(`  主上下文峰值   ${direct.peak}  →  ${delegated.peak}`);
console.log(`  主 agent 轮数  ${direct.rounds}  →  ${delegated.rounds}`);
console.log(`\n  子代理读了同样多的文件，但那些内容没有进主上下文。`);
```

- [ ] **Step 2: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/11-subagent/index.ts
```

Expected：B 的主上下文峰值明显低于 A。

**如果模型在 B 里没有派子代理**（直接自己 bash 一把梭），如实记录，
并在 README 里指出：工具描述决定了模型会不会用它——
`agent` 工具的描述必须说清「什么时候该派」，这跟第 07 课的结论是一回事。

- [ ] **Step 3: 写 README.md**

七节。要点：

- **第 1 节**：一次「翻遍所有文件找答案」的调查，会把几万 token 的原始内容灌进主上下文。可你只想要一句结论。
- **第 2 节**：mermaid `sequenceDiagram`，画主 agent → 子代理 → 工具 → 摘要回传，
  标出「子代理的工具输出不进主上下文」。
- **第 3 节**：三段：
  1. 子代理为什么用独立的 `messages` 数组——这是隔离的全部实现，没有别的魔法。
  2. **子代理的工具集里为什么不能有 `agent`**——防止无限递归派生。
  3. 只回传最后的文字摘要，不回传中间过程。
- **第 4 节**：贴真实输出，对比主上下文峰值。
- **第 5 节**：三个代价：
  子代理看不到主对话，任务描述写不清它就做错；
  它内部烧掉的 token 一样要付钱（输出里有这个数字），省的是**主上下文**不是总花费；
  摘要有损，主 agent 想追问细节只能重派一个。
- **第 6 节**：官方 Managed Agents 的多 agent 模式——roster 里放 `{"type": "self"}`
  让 agent 派生自己的副本，或者指定更便宜的模型（如 Haiku）跑读取密集的子任务。
- **第 7 节**：新增 `agent` 工具和 `runSubagent()`；主循环结构没变，
  只是多了一个分支——工具名是 `agent` 时走子代理，否则走普通 handler。

- [ ] **Step 4: 校验提交**

```bash
grep -c '^## [1-7]\.' examples/11-subagent/README.md
bunx tsc --noEmit
git add examples/11-subagent && git commit -m "docs: 11 课 子代理"
```

---

### Task 2: 12-background —— 后台任务

**Files:** `examples/12-background/index.ts`、`README.md`

**教学目标：** 一条要跑 30 秒的命令会把整个 agent 循环卡死。
解法是非阻塞执行 + 把完成通知**注入回对话流**。后半句才是难点。

- [ ] **Step 1: 写 index.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 15;

type TaskStatus = "running" | "completed" | "failed";

interface BgTask {
  id: string;
  command: string;
  status: TaskStatus;
  output: string;
}

interface Notification {
  id: string;
  command: string;
  status: TaskStatus;
  output: string;
}

// ============ 后台任务管理 ============
//
// 关键在 run() 立刻返回一个 id，不等命令跑完。
// 命令结束时把结果塞进通知队列，等主循环下一轮来取。

class BackgroundManager {
  private tasks = new Map<string, BgTask>();
  private queue: Notification[] = [];
  private seq = 0;

  run(command: string): string {
    const id = `bg-${++this.seq}`;
    const task: BgTask = { id, command, status: "running", output: "" };
    this.tasks.set(id, task);

    const child = spawn("sh", ["-c", command], { cwd: process.cwd() });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d.toString()));
    child.stderr.on("data", (d) => (buf += d.toString()));

    child.on("close", (code) => {
      task.status = code === 0 ? "completed" : "failed";
      task.output = buf.trim().slice(0, 2000) || "(没有输出)";
      // 命令跑完了，但主循环这会儿可能正在等 API 响应。
      // 所以不能直接打断它，只能先放进队列。
      this.queue.push({ id, command, status: task.status, output: task.output });
    });

    return `后台任务 ${id} 已启动：${command}`;
  }

  check(id?: string): string {
    if (id) {
      const t = this.tasks.get(id);
      if (!t) return `错误：没有任务 ${id}`;
      return `[${t.status}] ${t.command}\n${t.output || "(还在跑)"}`;
    }
    if (this.tasks.size === 0) return "没有后台任务。";
    return [...this.tasks.values()].map((t) => `${t.id}: [${t.status}] ${t.command}`).join("\n");
  }

  // 取出并清空队列。主循环每轮开头调一次。
  drain(): Notification[] {
    const out = [...this.queue];
    this.queue = [];
    return out;
  }

  get pending(): number {
    return [...this.tasks.values()].filter((t) => t.status === "running").length;
  }
}

const BG = new BackgroundManager();

const TOOLS: Anthropic.Tool[] = [
  {
    name: "background_run",
    description: "在后台执行一条耗时的 shell 命令，立刻返回任务 id，不阻塞你继续做别的事。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的 shell 命令" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "查看后台任务的状态。不填 id 就列出全部。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string", description: "任务 id，可不填" } },
    },
  },
  {
    name: "bash",
    description: "同步执行一条 shell 命令，会等它跑完。只适合快命令。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的 shell 命令" } },
      required: ["command"],
    },
  },
];

const SYSTEM = `你是一个编码助手。

耗时的命令用 background_run 放到后台，然后继续做别的事，不要干等。
后台任务完成时，系统会用 <background-results> 把结果告诉你。`;

async function main(task: string) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // ---- 每轮开头：把完成的后台任务注入对话 ----
    //
    // 这是整节课的关键。后台任务是异步完成的，但对话是一问一答的同步结构，
    // 没有地方"插话"。做法是伪造一轮 user/assistant 交换，把结果塞进去。
    const notifs = BG.drain();
    if (notifs.length > 0) {
      const text = notifs
        .map((n) => `[${n.id}] ${n.status}：${n.command}\n${n.output}`)
        .join("\n\n");
      messages.push({ role: "user", content: `<background-results>\n${text}\n</background-results>` });
      messages.push({ role: "assistant", content: "收到后台结果。" });
      console.log(`  ⇢ 注入了 ${notifs.length} 条后台结果`);
    }

    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS,
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n[第 ${turn} 轮] ${block.text.trim().slice(0, 200)}`);
      }
    }

    if (res.stop_reason !== "tool_use") {
      // 模型说完了，但后台可能还有任务没跑完——等一下再看
      if (BG.pending > 0) {
        console.log(`\n  还有 ${BG.pending} 个后台任务在跑，等 2 秒…`);
        await Bun.sleep(2000);
        if (BG.drain().length === 0 && BG.pending === 0) break;
        // 有新结果，塞回去让模型继续处理
        messages.push({ role: "user", content: "后台任务有更新，看一下 check_background。" });
        continue;
      }
      console.log(`\n  —— 结束，共 ${turn} 轮`);
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as any;
      console.log(`  → ${block.name}(${JSON.stringify(input).slice(0, 60)})`);

      let output: string;
      switch (block.name) {
        case "background_run": output = BG.run(input.command); break;
        case "check_background": output = BG.check(input.task_id); break;
        case "bash": {
          const r = await Bun.$`sh -c ${input.command}`.nothrow().quiet();
          output = (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
          break;
        }
        default: output = `错误：没有名为 ${block.name} 的工具`;
      }
      console.log(`    ${output.slice(0, 120)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  console.log(`\n  —— 达到 ${MAX_TURNS} 轮上限`);
}

await main(
  "用 background_run 在后台跑 `sleep 5 && echo 后台任务跑完了`，" +
    "不要干等——趁它跑的时候，用 bash 统计一下 examples 目录下有多少个 index.ts 文件。" +
    "两件事都有结果了再告诉我。",
);
```

- [ ] **Step 2: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/12-background/index.ts
```

Expected：模型先起后台任务，立刻去做统计，之后看到 `⇢ 注入了 N 条后台结果`。

**这一课的时序有不确定性。** 模型可能起完后台任务就去 `check_background` 干等。
如实记录实际发生的顺序，README 第 5 节讲清楚：
**注入机制只保证结果不会丢，不保证模型会聪明地安排顺序**——那取决于提示词。

- [ ] **Step 3: 写 README.md**

七节。要点：

- **第 1 节**：`npm install`、跑测试、起 dev server 都要几十秒。同步执行意味着整个 agent 停在那儿。
- **第 2 节**：mermaid `sequenceDiagram`，画三条时间线（主循环 / 后台进程 / 通知队列），
  重点画出「后台完成时主循环正在等 API，所以只能先入队」。
- **第 3 节**：三段：
  1. `spawn` 立刻返回，`close` 事件里才收结果——非阻塞的全部秘密。
  2. **为什么要队列而不是直接打断**：后台完成的时刻，主循环大概率正卡在 API 请求上，
     没有安全的插入点。队列把「什么时候完成」和「什么时候告诉模型」解耦。
  3. **注入为什么要伪造一对 user/assistant 消息**：对话结构是一问一答，
     凭空插一条 user 消息会让下一轮变成连续两条 user。补一条 assistant 确认，结构才合法。
- **第 4 节**：贴真实输出。
- **第 5 节**：三个代价 + 一个诚实说明：
  后台输出照样占上下文（注入进去就是 token）；
  进程退出时后台任务会被杀掉，长任务需要真正的守护进程；
  没有超时和资源上限，真实项目要加。
  诚实说明：**注入机制保证结果不丢，但模型会不会趁机去干别的，取决于提示词**。
- **第 6 节**：这一课没有官方原生方案——Messages API 不管你的进程调度。
  但可以提 Managed Agents 的会话容器：agent 的命令跑在 Anthropic 托管的沙箱里，
  会话是长期的，某种程度上把这件事变成了平台的事。
- **第 7 节**：新增 `BackgroundManager` 和两个工具；主循环多了一个「每轮开头 drain 通知」的步骤。

- [ ] **Step 4: 校验提交**

```bash
grep -c '^## [1-7]\.' examples/12-background/README.md
bunx tsc --noEmit
git add examples/12-background && git commit -m "docs: 12 课 后台任务"
```

---

### Task 3: 14-evals —— 怎么知道 agent 变好了还是变坏了

**Files:** `examples/14-evals/index.ts`、`examples/14-evals/agent.test.ts`、`README.md`

**教学目标：** 前面十几课每一课都在改 agent。改完怎么知道是变好了？
靠肉眼看输出是不行的——模型有随机性，你看到的可能只是运气。

**核心观点：** 要评的是 **trajectory（执行路径）**，不只是最终答案。
一个答对了但绕了八轮、调错三次工具的 agent，和一个两轮答对的，分数不该一样。

- [ ] **Step 1: 写 index.ts（可复用的带 trace 的 agent）**

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;

export interface ToolCall {
  name: string;
  input: any;
  output: string;
  isError: boolean;
}

// 一次运行的完整轨迹。评估要看的是它，不只是 finalText。
export interface Trace {
  finalText: string;
  toolCalls: ToolCall[];
  rounds: number;
  inputTokens: number;
  hitTurnLimit: boolean;
}

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
];

const handlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_file: async ({ path }) => await Bun.file(path).text(),
};

export async function runAgent(task: string, maxTurns = 10): Promise<Trace> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const toolCalls: ToolCall[] = [];
  let inputTokens = 0;
  let finalText = "";
  let rounds = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    rounds = turn;
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, messages, tools: TOOLS,
    });
    inputTokens += res.usage.input_tokens;
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      finalText = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { finalText, toolCalls, rounds, inputTokens, hitTurnLimit: false };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const handler = handlers[block.name];
      let output: string;
      let isError = false;
      try {
        output = handler ? await handler(block.input) : `错误：没有名为 ${block.name} 的工具`;
        isError = output.startsWith("错误：");
      } catch (e: any) {
        output = `错误：${e.message}`;
        isError = true;
      }
      toolCalls.push({ name: block.name, input: block.input, output, isError });
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }

  return { finalText, toolCalls, rounds, inputTokens, hitTurnLimit: true };
}

// 直接运行这个文件时，跑一次并把轨迹打出来
if (import.meta.main) {
  const trace = await runAgent("package.json 里 name 字段的值是什么？");
  console.log("最终回答：", trace.finalText.slice(0, 200));
  console.log("\n轨迹：");
  console.log(`  轮数        ${trace.rounds}`);
  console.log(`  工具调用    ${trace.toolCalls.map((c) => c.name).join(" → ") || "（无）"}`);
  console.log(`  出错次数    ${trace.toolCalls.filter((c) => c.isError).length}`);
  console.log(`  累计 input  ${trace.inputTokens} tokens`);
  console.log(`  撞轮数上限  ${trace.hitTurnLimit}`);
}
```

- [ ] **Step 2: 写 agent.test.ts**

```ts
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
```

- [ ] **Step 3: 真跑两样东西，都要抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/14-evals/index.ts
http_proxy= https_proxy= all_proxy= bun test examples/14-evals/agent.test.ts
```

**如果有测试挂了，不要改断言去迁就它。** 先判断是 agent 真的表现不好，还是断言太严。
- 断言太严（比如要求 ≤4 轮但模型稳定用 5 轮）→ 放宽阈值，并在 README 里说明为什么定这个阈值
- agent 真的表现不好 → **保留这个失败**，README 里如实展示。
  一个能暴露问题的测试比一个全绿的测试有价值。

- [ ] **Step 4: 写 README.md**

七节。要点：

- **第 1 节**：前面十三课每一课都在改 agent。改完你怎么知道变好了？
  跑一遍看着还行——但模型有随机性，你看到的可能只是这一次运气好。
- **第 2 节**：mermaid，画「只看最终答案」vs「看整条轨迹」的区别：
  两个 agent 都答对了，一个 2 轮直达，一个 8 轮里错了 3 次工具。分数不该一样。
- **第 3 节**：三段：
  1. `Trace` 结构为什么要记这些字段——每个字段对应一类可能的退化。
  2. **断言只能针对事实，不能针对措辞**。`toContain("learn-agent")` 可以，
     `toBe("项目名是 learn-agent")` 不行。
  3. 超时为什么要设 120 秒——`bun test` 默认 5 秒，真实 API 调用必然超。
- **第 4 节**：贴两份真实输出（`index.ts` 的轨迹打印 + `bun test` 的结果）。
- **第 5 节**：**这一课的局限要讲透**：
  每跑一次测试都要花钱花时间，所以回归集不能太大；
  模型随机性意味着测试本身是 flaky 的，同一套断言偶尔会挂；
  应对办法是断言留余量、关键用例跑多次看通过率，而不是追求 100% 绿。
  另外这里只有四个用例，真实项目的回归集应该随着发现的问题一起长大——
  每修一个 bug，就把它变成一个用例。
- **第 6 节**：没有官方原生方案，但可以提思路：
  用更强的模型给 agent 的轨迹打分（LLM-as-judge），
  以及生产环境采样真实流量做回归——这两件事都超出本教程范围。
- **第 7 节**：这一课没改 agent，只是给它加了 `Trace` 记录和一套测试。
  `runAgent` 是从第 03 课的循环抽出来的，多了一个记录轨迹的壳。

- [ ] **Step 5: 校验提交**

```bash
grep -c '^## [1-7]\.' examples/14-evals/README.md
bunx tsc --noEmit
git add examples/14-evals && git commit -m "docs: 14 课 evals"
```

---

### Task 4: 更新根 README 路线图

- [ ] 11、12、14 三行改成已完成加链接；mermaid 里三个节点移进 `done`（13 仍是 `planned`）
- [ ] 提交

---

## 完成标准

- [ ] 三课各有 `index.ts` + `README.md`，14 课另有 `agent.test.ts`
- [ ] 七节齐全、每课至少一张 mermaid 图
- [ ] 三课都能真跑，README 第 4 节是真实输出
- [ ] `bun test examples/14-evals/agent.test.ts` 能跑，结果如实记录（挂了也如实写）
- [ ] `bunx tsc --noEmit` 零错误
- [ ] `grep -rn 'yangjie\|/Users/yangjie' examples/ README.md` 无输出
- [ ] `grep -rn 'ugreen-ai-model\|claude-opus-5' examples/*/index.ts examples/*/*.test.ts` 无输出
- [ ] 根 README 路线图已更新
