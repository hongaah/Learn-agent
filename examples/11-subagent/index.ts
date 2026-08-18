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

async function runMain(
  label: string,
  tools: Anthropic.Tool[],
  task: string,
  system?: string,
) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const perRound: number[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools,
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

// 任务特意要求"逐个读取完整内容"。
// 如果只问行数，一条 `wc -l` 就够了，文件内容根本不会进上下文，
// 也就看不出隔离的价值——这一点第 5 节会展开。
const TASK =
  "逐个读取 examples 目录下每一课 README.md 的完整内容，" +
  "然后用三句话概括这套教程的知识是怎么一层层递进的。";

// 两组用同一个任务。区别只有两处：B 多了 agent 工具，
// 以及 B 的 system prompt 里写明了什么时候该委派。
// 光给工具不给指引，模型多半不会用——这一点第 5 节会展开。
const DELEGATE_SYSTEM = `你是一个编码助手。

遇到需要翻阅多个文件才能得出结论的调查任务，用 agent 工具派一个子代理去做，
你只需要它给你的结论。不要自己逐个读文件——那会让无关的原始内容堆满你的上下文。`;

const direct = await runMain("A · 主 agent 自己动手", BASE_TOOLS, TASK);
const delegated = await runMain(
  "B · 派给子代理", [...BASE_TOOLS, AGENT_TOOL], TASK, DELEGATE_SYSTEM,
);

console.log(`\n${"=".repeat(46)}\n对比\n${"=".repeat(46)}`);
console.log(`  主上下文峰值   ${direct.peak}  →  ${delegated.peak}`);
console.log(`  主 agent 轮数  ${direct.rounds}  →  ${delegated.rounds}`);
console.log(`\n  子代理读了同样多的文件，但那些内容没有进主上下文。`);
