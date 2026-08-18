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
