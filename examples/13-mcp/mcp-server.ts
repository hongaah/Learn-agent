/**
 * 一个最小的 MCP server。
 *
 * 它通过标准输入输出跟客户端通信：每行一条 JSON-RPC 2.0 消息。
 * 真实的 MCP server（GitHub、数据库、Slack 那些）协议部分跟这里一模一样，
 * 区别只在提供的工具不同。
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

// 这个 server 提供的工具。schema 长得跟 Anthropic 的 tool 几乎一样，
// 只是字段名叫 inputSchema（驼峰）而不是 input_schema（下划线）。
const TOOLS = [
  {
    name: "count_lines",
    description: "统计一个文件有多少行。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
  },
  {
    name: "find_todos",
    description: "在项目里搜索所有 TODO 和 FIXME 注释，返回文件名和行号。",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "搜索目录，默认当前目录" },
      },
    },
  },
];

async function callTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "count_lines": {
      const r = await Bun.$`wc -l < ${args.path}`.nothrow().quiet();
      if (r.exitCode !== 0) return `读不到 ${args.path}`;
      return `${args.path}: ${r.stdout.toString().trim()} 行`;
    }
    case "find_todos": {
      const dir = args.dir ?? ".";
      const r =
        await Bun.$`grep -rn "TODO\\|FIXME" ${dir} --include=*.ts --exclude-dir=node_modules`
          .nothrow()
          .quiet();
      const out = r.stdout.toString().trim();
      return out || "没有找到 TODO 或 FIXME。";
    }
    default:
      return `未知工具：${name}`;
  }
}

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// 主循环：一行一条请求，处理完写一行响应
for await (const line of console) {
  if (!line.trim()) continue;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    continue;
  }

  switch (req.method) {
    case "initialize":
      // 握手：告诉客户端我支持什么
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "learn-agent-demo-server", version: "1.0.0" },
        },
      });
      break;

    case "tools/list":
      send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
      break;

    case "tools/call": {
      const text = await callTool(req.params.name, req.params.arguments ?? {});
      // MCP 的工具结果是一个 content 数组，跟 Anthropic 的消息块很像
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text }] },
      });
      break;
    }

    default:
      if (req.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `不支持的方法：${req.method}` },
        });
      }
  }
}
