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
