# Learn-agent 第五批（13 课 + 两个附录）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 交付第 13 课 MCP，以及附录 A（lite-agent 参考实现导读）、附录 B（什么时候别自己写）。这是全套教程的最后一批。

**依据：** `docs/superpowers/specs/2026-08-18-learn-agent-tutorial-design.md`
**风格样板：** `examples/01-first-call/README.md`
**硬规则：** 仓库根 `CLAUDE.md`

---

## Global Constraints

1. 模型 ID 只从 `process.env.MODEL_ID` 读。
2. **不引入任何新依赖。** 13 课手写最小 MCP 实现，不装 `@modelcontextprotocol/sdk`——
   官方 SDK 放第 6 节讲。
3. `max_tokens` 统一 16000。
4. **课程**（13）要七节 + 元信息 + mermaid；**附录**（A、B）是纯文档，
   不要求七节结构，但要有 mermaid 图，且开头要有一句话说明这是什么。
5. 写作照 `CLAUDE.md` 的「写作边界」。
6. 去个人化：不许出现真实用户名和本机绝对路径。
7. 实录必须真跑（附录除外，它没有可运行代码）。
8. 中文讲解 + 中文注释。

---

### Task 1: 13-mcp —— 接入 MCP

**Files:**
- Create: `examples/13-mcp/mcp-server.ts`（一个最小 MCP server）
- Create: `examples/13-mcp/index.ts`（agent + MCP client）
- Create: `examples/13-mcp/README.md`

**教学目标：** 前面十二课的工具都是自己写的。真实世界里 GitHub、数据库、
Slack 早就有人写好了 MCP server——**接上就能用，不用每家再写一遍。**

**MCP 协议就三件事**（这一课只实现这三件）：
`initialize` 握手、`tools/list` 要工具清单、`tools/call` 调工具。
传输走 stdio，消息格式是 JSON-RPC 2.0，一行一条。

- [ ] **Step 1: 写 mcp-server.ts**

```ts
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
```

- [ ] **Step 2: 写 index.ts**

```ts
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
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

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
```

- [ ] **Step 3: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/13-mcp/index.ts
```

Expected：先打印连上了哪个 server、它提供几个工具，然后 agent 调用这些工具完成任务。
每次工具调用前面都带 `[MCP]` 标记，说明是转发出去的。

**如果 `find_todos` 返回"没有找到"**，那是正常的——教程代码里本来就不该有 TODO。
如实记录即可，不要为了输出好看去代码里塞一个 TODO。

- [ ] **Step 4: 写 README.md**

七节。要点：

- **第 1 节**：前十二课的工具都是自己写的。可你要接 GitHub、数据库、Slack 呢？
  每家写一遍，每换个 agent 框架再写一遍。MCP 就是来解决这个重复的。
- **第 2 节**：mermaid `sequenceDiagram`，画 agent ↔ MCP client ↔ MCP server 三层，
  标出 `initialize` / `tools/list` / `tools/call` 三次交互。
- **第 3 节**：三段：
  1. **协议只有三个方法**——握手、要清单、调工具。JSON-RPC over stdio，一行一条。
  2. **schema 转换几乎是一一对应的**（`inputSchema` ↔ `input_schema`）。
     正因为这么像，同一个 MCP server 才能被 Claude Desktop、Cursor、你自己的 agent 一起用。
  3. **客户端要按行缓冲**——stdout 的 chunk 边界和消息边界不是一回事，
     代码里那个 `buffer` 就是干这个的。这是自己写 MCP 客户端必踩的坑。
- **第 4 节**：贴真实输出。
- **第 5 节**：三个代价：
  多一个进程，要管它的生命周期（代码里 `close()` 别忘了）；
  stdio 传输只适合本地，远程要用 HTTP + SSE；
  这里没实现的东西还有很多——resources、prompts、通知、错误恢复、并发请求。
- **第 6 节**：官方两条路。
  一是 `@modelcontextprotocol/sdk`，别自己手写生产代码；
  二是 Claude API 的 **MCP connector**：`mcp_servers` 加 `tools: [{type: "mcp_toolset", ...}]`
  加 beta 头 `mcp-client-2025-11-20`，服务端直接连远程 MCP server，你连客户端都不用写。
  **提醒**：`mcp_servers` 单独给是不行的，两半都要。
- **第 7 节**：这一课的 `index.ts` 里**没有一个本地工具实现**——
  工具清单来自 server，调用也转发给 server。这是和前十二课最大的结构区别。

- [ ] **Step 5: 校验提交**

```bash
grep -c '^## [1-7]\.' examples/13-mcp/README.md
bunx tsc --noEmit
git add examples/13-mcp && git commit -m "docs: 13 课 接入 MCP"
```

---

### Task 2: 附录 A —— lite-agent 参考实现导读

**Files:** `examples/appendix-a-lite-agent/README.md`（纯文档，无代码）

**这是什么：** 教程十四课都是为讲清一个概念而重写的最小实现。
附录 A 讲一个真实项目长什么样——`lite-agent`（5.1k 行 TypeScript）
如何把这些机制组织在一起，以及它多做了哪些教程里省略的事。

**重点讲两块教程降级掉的内容：** 多 agent 协作（`agentTeam.ts`，739 行）
和 git worktree 隔离（`worktree.ts`，384 行）。

**不要求七节结构**，但需要：开头一句话说明这是什么、至少两张 mermaid 图、
明确指出教学版和生产版的差距在哪。

- [ ] **Step 1: 写 README.md**

结构建议：

```markdown
# 附录 A · 生产级实现长什么样

> 十四课的代码都是为讲清一个概念重写的最小版本。这一篇讲真实项目怎么组织它们。
> 参考对象是 lite-agent，一个 5.1k 行的 TypeScript agent 框架。

## 十四课的机制在真实项目里的位置
[一张表：教程第几课 → lite-agent 对应文件 → 行数 → 生产版多做了什么]

## 多 agent 协作
[这是教程降级掉的内容之一。用 mermaid 画 lead + teammate + 消息总线 + 任务看板的结构。
讲清楚它和第 11 课 subagent 的本质区别：
- subagent 是阻塞的、一次性的、没有身份
- teammate 是自治的、长期的、有身份，能自己从任务看板认领活

然后讲它为什么难：
- 消息总线用 JSONL 文件，读即清空，崩溃会丢消息
- teammate 的退出路径有五条（idle 超时 / 强制关停 / 优雅关停 / API 失败 / 崩溃），
  每条都要通知 lead，漏一条 lead 就会一直等
- 上下文压缩之后 teammate 会忘记自己是谁，要重新注入身份
- 治理协议：teammate 提交计划要等 lead 审批才能执行

这些复杂度不是设计过度，是自治多 agent 这件事本身的成本。]

## git worktree 隔离
[另一块降级内容。用 mermaid 画多个 teammate 在各自 worktree 里并行改代码。
讲清楚要解决的问题：两个 agent 同时改同一个文件必然冲突。
以及它引入的新问题：worktree 的生命周期谁管、任务失败了分支怎么清理、
合并冲突谁来解。]

## 教学版和生产版的差距清单
[按类别列，每条一句话：
- 安全：教程只有 safePath 和白名单，生产要考虑符号链接、子进程逃逸、容器隔离
- 可靠性：错误传播、重试、审批超时、消息 ACK
- 资源：token 预算、墙钟超时、并发上限
- 可观测性：结构化日志、tracing、按 request_id 追全链路
- 持久化：教程的状态都在内存，进程一退就没]

## 什么时候你需要这些
[诚实的判断建议：多数人不需要自治多 agent。
先用第 11 课的 subagent，撑不住了再考虑。]
```

- [ ] **Step 2: 校验提交**

```bash
grep -c '```mermaid' examples/appendix-a-lite-agent/README.md   # 应 ≥2
git add examples/appendix-a-lite-agent
git commit -m "docs: 附录 A 生产级实现导读"
```

---

### Task 3: 附录 B —— 什么时候别自己写

**Files:** `examples/appendix-b-dont-diy/README.md`（纯文档，无代码）

**这是什么：** 读者学完十四课会手写 agent 了。这一篇告诉他们**什么时候不该手写**。

**四种方案的核心区别是两个问题**：谁提供 harness（agent 循环 + 上下文管理）、
谁提供部署（跑在哪）。

- [ ] **Step 1: 写 README.md**

必须包含这张对比表（内容准确，不要改动技术事实）：

| 方案 | 你写什么 | harness / 部署 | 什么时候用 |
|---|---|---|---|
| **手写循环**（本教程） | `while (stop_reason === "tool_use")` 整个循环 | 都是你的 | 要完全掌控控制流；或者学习 |
| **Tool Runner** | 只写工具函数 | SDK 给 harness，你自己部署 | 想要自定义工具但不想手写循环——多数情况的默认选择 |
| **Managed Agents** | agent 配置 | Anthropic 给 harness **和** 托管沙箱 | 要托管的有状态 agent、长会话、定时触发 |
| **Claude Agent SDK** | 一个 prompt + 配置 | SDK 给完整 Claude Code harness 和内置工具，你自己部署 | 想要开箱即用的编码/文件 agent |

要讲清的几个点：

1. **Tool Runner 不是 Claude Agent SDK。** 名字像，是两个不同的包：
   Tool Runner 在 `@anthropic-ai/sdk` 里（`client.beta.messages.toolRunner`），
   只帮你跑「调用→执行→回填」的循环，工具全部由你提供；
   Claude Agent SDK 是 `@anthropic-ai/claude-agent-sdk`，是 Claude Code 打包成的库，
   自带文件读写、bash、搜索等一整套工具。
2. **前三种里只有 Managed Agents 管部署。** harness 和部署是两个独立的问题，
   这是区分它们最有用的角度。
3. **先问要不要 agent。** 四条判断标准：任务是否多步且难以提前完全指定、
   结果是否值得更高的成本和延迟、模型是否胜任这类任务、出错能否被发现和恢复。
   任何一条答不上来，就退回更简单的做法（单次调用或固定流程的工作流）。

还要有一张 mermaid 决策图：从「要不要 agent」开始，到四个方案的分支。

**最后一节写「学完这套教程之后」**：
指出手写循环的真正价值不是拿去做生产，而是你现在能看懂上面每个方案在替你做什么、
出问题时知道该往哪查。

- [ ] **Step 2: 校验提交**

```bash
grep -c '```mermaid' examples/appendix-b-dont-diy/README.md   # 应 ≥1
git add examples/appendix-b-dont-diy
git commit -m "docs: 附录 B 什么时候别自己写"
```

---

### Task 4: 收尾 —— 根 README 定稿

- [ ] 13 课改成已完成加链接；mermaid 里 C13 移进 `done`，`planned` 那行删掉
- [ ] 路线图表格末尾加两行附录，链到 `appendix-a-lite-agent/` 和 `appendix-b-dont-diy/`
- [ ] 顶部「什么是 agent」那节后面加一句：全部十四课加两个附录已完成
- [ ] 提交

---

## 完成标准

- [ ] 13 课有三个文件（`mcp-server.ts` / `index.ts` / `README.md`），七节齐全
- [ ] 13 课能真跑，README 第 4 节是真实输出
- [ ] 两个附录各有 README，附录 A ≥2 张 mermaid 图，附录 B ≥1 张
- [ ] 没有引入任何新依赖：`package.json` 的 dependencies 仍然只有 `@anthropic-ai/sdk`
- [ ] `bunx tsc --noEmit` 零错误
- [ ] `grep -rn 'yangjie\|/Users/yangjie' examples/ README.md` 无输出
- [ ] 根 README 路线图全部十四课加两附录都已标注完成
