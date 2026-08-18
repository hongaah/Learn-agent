import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 15;

// ---- microCompact 的三个参数 ----
const KEEP_RECENT = 2;         // 最近几个 tool_result 保持原样（模型正在用它们）
const COMPACT_THRESHOLD = 400; // 短输出压了也省不下多少，不值得
const PREVIEW_LENGTH = 120;    // 压缩后保留多少字符的预览

const SYSTEM = `你是一个在当前目录工作的编码助手。优先使用工具，做完用一句话总结。`;

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

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_file: async ({ path }) => await Bun.file(path).text(),
};

// ============ 轻量压缩：把旧的工具输出换成占位符 ============
//
// 思路：模型真正需要逐字重读的，只有最近几次工具输出。
// 更早的那些，留一句"我用 read_file 读过某文件，开头是……"就够它记得发生过什么。

function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // 1. 按出现顺序收集所有 tool_result 的 id
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result") ids.push(b.tool_use_id);
    }
  }
  if (ids.length <= KEEP_RECENT) return messages;

  // 除了最近 KEEP_RECENT 个，其余都是压缩对象
  const targets = new Set(ids.slice(0, -KEEP_RECENT));

  // 2. 建 tool_use_id → 工具名 的映射，占位符里要说清是哪个工具产生的
  const toolNames: Record<string, string> = {};
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") toolNames[b.id] = b.name;
    }
  }

  // 3. 替换。返回新数组，不改原对象
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const content = m.content.map((b) => {
      if (
        b.type === "tool_result" &&
        targets.has(b.tool_use_id) &&
        typeof b.content === "string" &&
        b.content.length > COMPACT_THRESHOLD
      ) {
        const name = toolNames[b.tool_use_id] ?? "未知工具";
        const preview = b.content.slice(0, PREVIEW_LENGTH).replace(/\n/g, " ");
        return { ...b, content: `[已压缩：${name} 的输出，开头是 "${preview}…"]` };
      }
      return b;
    });
    return { ...m, content };
  });
}

// ============ 重度压缩：让模型把整段历史总结成一段话 ============
//
// microCompact 顶不住时（历史本身就很长，不只是工具输出大）才动用。
// 原始历史先落盘，压缩是有损的，别把信息彻底丢了。

async function autoCompact(
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  const path = `.transcripts/transcript_${Date.now()}.jsonl`;
  await Bun.write(path, messages.map((m) => JSON.stringify(m)).join("\n"));
  console.log(`  原始历史已存到 ${path}`);

  // max_tokens 给 2000：我们要的是摘要，不是长篇大论
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content:
          "把下面这段对话总结成一段话，保留三件事：1) 已经完成了什么 " +
          "2) 当前进行到哪一步 3) 做过哪些关键决定。简洁但别丢关键细节。\n\n" +
          JSON.stringify(messages).slice(0, 60000),
      },
    ],
  });

  const summary =
    res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "(没有摘要)";

  // 整段历史被两条消息取代
  return [
    { role: "user", content: `[历史已压缩，原始记录见 ${path}]\n\n${summary}` },
    { role: "assistant", content: "了解，我已经掌握之前的上下文，继续。" },
  ];
}

// ============ 对照：同一个任务，压缩 vs 不压缩 ============

async function run(label: string, useCompact: boolean, task: string) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const perRound: number[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (useCompact) messages = microCompact(messages);

    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS,
    });
    perRound.push(res.usage.input_tokens);
    console.log(`  第 ${String(turn).padStart(2)} 轮  input=${String(res.usage.input_tokens).padStart(6)}`);

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

  const peak = Math.max(...perRound);
  const total = perRound.reduce((a, b) => a + b, 0);
  console.log(`  —— ${perRound.length} 轮，峰值 ${peak}，累计 ${total}`);
  return { rounds: perRound.length, peak, total };
}

// 这个任务会读 7 个 README，每个几 KB，正好把工具输出撑大
const TASK =
  "逐个读取 examples 目录下每一课的 README.md，然后告诉我每一课的标题分别是什么。";

const plain = await run("不压缩", false, TASK);
const compacted = await run("开启 microCompact", true, TASK);

console.log(`\n${"=".repeat(46)}\n对比\n${"=".repeat(46)}`);
console.log(`  峰值 input_tokens   ${plain.peak}  →  ${compacted.peak}`);
console.log(`  累计 input_tokens   ${plain.total}  →  ${compacted.total}`);
const saved = Math.round((1 - compacted.total / plain.total) * 100);
console.log(`  累计省下 ${saved}%`);

// ============ 演示重度压缩 ============
console.log(`\n${"=".repeat(46)}\nautoCompact 演示\n${"=".repeat(46)}`);
const long: Anthropic.MessageParam[] = [
  { role: "user", content: "帮我重构 src 下的工具模块" },
  { role: "assistant", content: "好的，我先看看目录结构。" },
  { role: "user", content: "已经拆成了三个文件：bash.ts、file.ts、todo.ts" },
  { role: "assistant", content: "拆分完成，接下来补测试。" },
];
const before = JSON.stringify(long).length;
const after = await autoCompact(long);
console.log(`  压缩前 ${long.length} 条消息（${before} 字符）`);
console.log(`  压缩后 ${after.length} 条消息（${JSON.stringify(after).length} 字符）`);
console.log(`\n  摘要内容：\n  ${String(after[0]!.content).replace(/\n/g, "\n  ").slice(0, 400)}`);
