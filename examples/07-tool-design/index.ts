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
