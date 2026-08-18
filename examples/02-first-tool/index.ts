import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;

// ---------- 工具的两半：声明 + 实现 ----------

// 上半：告诉模型有这么个工具。模型只看得到这段描述
const bashTool: Anthropic.Tool = {
  name: "bash",
  description: "在当前目录执行一条 shell 命令，返回它的输出。",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
  },
};

// 下半：真正干活的是这段代码，模型碰不到
async function runBash(command: string): Promise<string> {
  // 注意必须写成 sh -c ${command}。
  // 直接写 Bun.$`${command}` 会把整串当成一个可执行文件名，跑不起来——
  // Bun 默认转义插值，这是防命令注入的安全设计。
  const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
  const output = (r.stdout.toString() + r.stderr.toString()).trim();
  return output || "(没有输出)";
}

// ---------- 第 1 轮：模型说它想用工具 ----------

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "当前目录下有哪些文件？" },
];

const first = await client.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  messages,
  tools: [bashTool],
});

console.log("第 1 轮 stop_reason =", first.stop_reason); // 应该是 tool_use

// 把模型这轮的回复整个存进历史（里面装着 tool_use 块）
messages.push({ role: "assistant", content: first.content });

// ---------- 中间：你的代码去执行 ----------

const toolResults: Anthropic.ToolResultBlockParam[] = [];

for (const block of first.content) {
  if (block.type !== "tool_use") continue;

  const input = block.input as { command: string };
  console.log(`\n模型想执行: ${input.command}`);
  console.log(`tool_use.id = ${block.id}`);

  const output = await runBash(input.command);
  console.log(`执行结果:\n${output}`);

  toolResults.push({
    type: "tool_result",
    tool_use_id: block.id, // 必须原样回填，模型靠它对上号
    content: output,
  });
}

// 关键：工具结果是以 user 角色发回去的，不是 assistant
messages.push({ role: "user", content: toolResults });

// ---------- 第 2 轮：模型看到结果，给出人话回答 ----------

const second = await client.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  messages,
  tools: [bashTool],
});

console.log("\n第 2 轮 stop_reason =", second.stop_reason); // 应该是 end_turn
console.log("\n模型的最终回答：");
for (const block of second.content) {
  if (block.type === "text") console.log(block.text);
}
