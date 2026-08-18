import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 20;

// agent 只允许在这个目录里活动
const WORKDIR = process.cwd();

const SYSTEM = `你是一个在 ${WORKDIR} 工作的编码助手。
你只能访问这个目录内的文件。优先使用工具而不是猜测。`;

// ---------- 第一道防线：路径不能逃逸 ----------

function safePath(p: string): string {
  const full = resolve(WORKDIR, p);

  // 注意这里必须比较 WORKDIR + "/"。
  // 如果只写 full.startsWith(WORKDIR)，那么 /Users/me/work-evil
  // 会被判定为在 /Users/me/work 之内——前缀匹配的经典漏洞。
  if (full !== WORKDIR && !full.startsWith(WORKDIR + "/")) {
    throw new Error(`路径逃逸出工作目录：${p}`);
  }
  return full;
}

// ---------- 第二道防线：危险操作要人点头 ----------

// 只读命令直接放行，不打扰用户
const AUTO_APPROVE = /^(ls|pwd|cat|head|tail|wc|find|grep|git status|git log|git diff)\b/;

async function approve(action: string): Promise<boolean> {
  process.stdout.write(`\n  ⚠️  agent 想执行：${action}\n     允许吗？(y/N) `);
  for await (const line of console) {
    return line.trim().toLowerCase() === "y";
  }
  return false;
}

// ---------- 工具 ----------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "在工作目录执行一条 shell 命令，返回它的输出。",
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
    description: "读取工作目录内一个文件的全部内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "把内容写入工作目录内的文件，覆盖原有内容。",
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

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    // 只读命令自动放行，其余一律问人
    if (!AUTO_APPROVE.test(command.trim())) {
      const ok = await approve(`bash: ${command}`);
      if (!ok) return "用户拒绝了这条命令。请换一个办法，或者问用户想怎么做。";
    }
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    const out = (r.stdout.toString() + r.stderr.toString()).trim();
    return out || "(没有输出)";
  },

  read_file: async ({ path }) => {
    return await Bun.file(safePath(path)).text();
  },

  write_file: async ({ path, content }) => {
    const full = safePath(path);
    const ok = await approve(`写入文件: ${path}（${content.length} 个字符）`);
    if (!ok) return "用户拒绝了这次写入。";
    await Bun.write(full, content);
    return `已写入 ${path}`;
  },
};

// ---------- agent 循环（与 03 课相同） ----------

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

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n[第 ${turn} 轮] ${block.text.trim()}`);
      }
    }

    if (res.stop_reason !== "tool_use") {
      console.log(`\n循环结束，共 ${turn} 轮。`);
      return;
    }

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
          output = `错误：${e.message}`;
        }
      }
      console.log(`    ${output.slice(0, 200)}`);

      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    messages.push({ role: "user", content: results });
  }

  console.log(`\n达到 ${MAX_TURNS} 轮上限，强制停止。`);
}

// 注意这里明确要求用 read_file 工具。
// 如果不指定，模型可能选 bash 去 cat，而 cat 在只读白名单里会被自动放行,
// 就绕过了 safePath —— 这个洞是真实存在的，README 第 5 节会正面讲。
await runAgent(
  "用 read_file 工具读 package.json，告诉我这个项目叫什么。" +
    "然后同样用 read_file 工具试着读 /etc/passwd，把发生的事告诉我。",
);
