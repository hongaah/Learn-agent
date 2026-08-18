import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 20; // 防止模型陷入死循环烧钱

const SYSTEM = `你是一个在当前目录工作的编码助手。
优先使用工具而不是猜测。做完之后用一句话总结你做了什么。`;

// ---------- 三个工具 ----------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "在当前目录执行一条 shell 命令，返回它的输出。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取一个文件的全部内容。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
      },
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

// ---------- 工具实现，用一张分发表按名字找 ----------

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    const out = (r.stdout.toString() + r.stderr.toString()).trim();
    return out || "(没有输出)";
  },

  read_file: async ({ path }) => {
    return await Bun.file(path).text();
  },

  write_file: async ({ path, content }) => {
    await Bun.write(path, content);
    return `已写入 ${path}（${content.length} 个字符）`;
  },
};

// ---------- agent 循环 ----------

async function runAgent(userInput: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userInput },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages,
      tools: TOOLS,
    });

    messages.push({ role: "assistant", content: res.content });

    // 打印这一轮的 token 消耗。留意 input_tokens 会一轮比一轮大——
    // 因为每一轮都把之前所有的对话和工具输出重新发了一遍。
    console.log(
      `\n[第 ${turn} 轮] 输入 ${res.usage.input_tokens} tokens` +
        ` / 输出 ${res.usage.output_tokens} tokens`,
    );

    // 顺手把模型这轮说的话打出来
    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`  ${block.text.trim()}`);
      }
    }

    // 模型不再要工具了，任务结束
    if (res.stop_reason !== "tool_use") {
      console.log(`\n循环结束，共 ${turn} 轮。stop_reason=${res.stop_reason}`);
      return;
    }

    // 一轮里模型可能同时要好几个工具，全部执行
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of res.content) {
      if (block.type !== "tool_use") continue;

      console.log(`  > ${block.name}(${JSON.stringify(block.input)})`);

      const handler = toolHandlers[block.name];
      let output: string;

      if (!handler) {
        output = `错误：没有名为 ${block.name} 的工具`;
      } else {
        try {
          output = await handler(block.input);
        } catch (e: any) {
          // 工具报错不能让整个 agent 崩掉，要把错误告诉模型让它自己想办法
          output = `错误：${e.message}`;
        }
      }

      console.log(`    ${output.slice(0, 200)}`);

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    // 关键：这一轮所有工具结果放进同一条 user 消息。
    // 拆成多条会让模型以后不敢再一次要多个工具。
    messages.push({ role: "user", content: results });
  }

  console.log(`\n达到 ${MAX_TURNS} 轮上限，强制停止。`);
}

await runAgent(
  "统计一下当前目录下有多少个 .md 文件，把文件名列表写进 md-list.txt，然后告诉我结果。",
);
