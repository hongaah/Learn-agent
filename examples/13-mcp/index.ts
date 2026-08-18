import Anthropic from "@anthropic-ai/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 12;

// ============ 最小 MCP 客户端 ============
//
// 职责就三件：启动 server 进程、发 JSON-RPC 请求、把响应按 id 对回去。

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (result: any) => void>();
  private buffer = "";

  constructor(command: string, args: string[]) {
    // 三个流都用 pipe：stdin/stdout 走协议，stderr 转到我们自己的错误输出，
    // 这样 server 崩了能第一时间看见。
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.pipe(process.stderr);

    // 响应可能被拆成多个 chunk，也可能一个 chunk 里有多条，
    // 所以要按换行切分后再逐条解析
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg.result ?? msg.error);
        }
      }
    });
  }

  private request(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "learn-agent", version: "1.0.0" },
    });
  }

  async listTools(): Promise<any[]> {
    const r = await this.request("tools/list");
    return r.tools;
  }

  async callTool(name: string, args: any): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r?.content) {
      return r.content.map((c: any) => c.text ?? "").join("\n");
    }
    return JSON.stringify(r);
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// ============ MCP 工具 → Anthropic 工具 ============
//
// 两边的 schema 几乎一样，差别只有字段名的写法。
// 这也是 MCP 能被各家 agent 直接用起来的原因。

function toAnthropicTool(mcpTool: any): Anthropic.Tool {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    input_schema: mcpTool.inputSchema,
  };
}

// ============ agent 循环 ============

const mcp = new McpClient("bun", ["run", join(import.meta.dir, "mcp-server.ts")]);

const info = await mcp.initialize();
console.log(`已连接 MCP server：${info.serverInfo.name} v${info.serverInfo.version}`);

const mcpTools = await mcp.listTools();
console.log(`它提供了 ${mcpTools.length} 个工具：${mcpTools.map((t) => t.name).join(", ")}\n`);

const TOOLS = mcpTools.map(toAnthropicTool);

async function runAgent(task: string) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, messages, tools: TOOLS,
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n[第 ${turn} 轮] ${block.text.trim().slice(0, 300)}`);
      }
    }

    if (res.stop_reason !== "tool_use") {
      console.log(`\n  —— 结束，共 ${turn} 轮`);
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      console.log(`  → [MCP] ${block.name}(${JSON.stringify(block.input)})`);
      // 注意这里：本地没有任何工具实现，全部转发给 MCP server
      const output = await mcp.callTool(block.name, block.input);
      console.log(`    ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  console.log(`\n  —— 达到 ${MAX_TURNS} 轮上限`);
}

await runAgent(
  "统计一下 examples/01-first-call/index.ts 有多少行，" +
    "再看看 examples 目录下有没有遗留的 TODO 注释。",
);

mcp.close();
