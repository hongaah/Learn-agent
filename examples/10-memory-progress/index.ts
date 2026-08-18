import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 12;

const PROGRESS_FILE = join(import.meta.dir, "PROGRESS.md");

const SYSTEM = `你是一个编码助手，负责一个要分多次会话完成的长任务。

## 进度文件的规矩
- 每完成一个步骤，立刻用 write_progress 更新进度。
- 进度里要写清楚：已完成什么、正在做什么、下一步做什么。
- 你随时可能被中断，下一次会话的你只能看到这个文件，看不到现在的对话。
  所以写给未来的自己看，别省略上下文。`;

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
    name: "read_progress",
    description: "读取进度文件，了解之前的会话做到哪一步了。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "write_progress",
    description: "覆盖写入进度文件。每完成一步就更新一次。",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "完整的进度内容，markdown 格式" },
      },
      required: ["content"],
    },
  },
];

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_progress: async () => {
    if (!existsSync(PROGRESS_FILE)) return "进度文件还不存在，这是第一次会话。";
    return await Bun.file(PROGRESS_FILE).text();
  },
  write_progress: async ({ content }) => {
    await Bun.write(PROGRESS_FILE, content);
    return `进度已更新（${content.length} 字符）`;
  },
};

// 一次「会话」。注意 messages 是函数内的局部变量——
// 会话结束它就没了，这正是我们要模拟的情况。
async function session(label: string, userInput: string) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userInput }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS,
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`  [第 ${turn} 轮] ${block.text.trim().slice(0, 200)}`);
      }
    }

    if (res.stop_reason !== "tool_use") {
      console.log(`  —— 会话结束，共 ${turn} 轮`);
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      console.log(`    → ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
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
  console.log(`  —— 达到 ${MAX_TURNS} 轮上限`);
}

// 每次运行都从干净状态开始，方便反复演示
if (existsSync(PROGRESS_FILE)) {
  await Bun.$`rm -f ${PROGRESS_FILE}`.quiet();
  console.log("（已清除上次的进度文件）");
}

// ---- 第一次会话：开工，做一部分，写进度 ----
await session(
  "第 1 次会话",
  "任务：统计 examples 目录下每一课的 README.md 各有多少行。" +
    "这次会话只统计前两课，统计完把进度写下来就停。",
);

console.log(`\n${"-".repeat(46)}`);
console.log("进度文件现在的内容：");
console.log("-".repeat(46));
console.log(await Bun.file(PROGRESS_FILE).text());

// ---- 第二次会话：全新的 messages，只靠进度文件接上 ----
// 注意这里没有传任何上一次的对话内容
await session(
  "第 2 次会话（全新上下文，只有进度文件）",
  "继续之前没做完的任务。先读进度文件搞清楚做到哪了。",
);

console.log(`\n${"-".repeat(46)}`);
console.log("最终进度文件：");
console.log("-".repeat(46));
console.log(await Bun.file(PROGRESS_FILE).text());
