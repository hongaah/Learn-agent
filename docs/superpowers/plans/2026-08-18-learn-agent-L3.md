# Learn-agent 第三批（08–10 课）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 `- [ ]` 复选框。

**Goal:** 交付 L3 上下文工程剩余三课：压缩、按需加载、外部记忆。

**共同结构：** 这三课都是「先手写一遍理解原理，再指出官方原生方案」。
第 6 节的原生对照是这三课的核心增量——市面教程大多停在手写，不告诉读者 2026 年该用什么。

**依据：** `docs/superpowers/specs/2026-08-18-learn-agent-tutorial-design.md`
**风格样板：** `examples/01-first-call/README.md`
**硬规则：** 仓库根 `CLAUDE.md`，每个 task 都适用。

---

## Global Constraints

1. 模型 ID 只从 `process.env.MODEL_ID` 读。
2. 主线代码只用 `model` / `max_tokens` / `messages` / `system` / `tools`。
   beta 特性（`context_management`、`compact_20260112`、tool search、memory tool）
   **一律只进第 6 节**，带警示行：
   `> ⚠️ 本节需要 Anthropic 官方 key。第三方兼容端点大多不支持。`
   已实测：带 beta 头的请求在本端点返回 400（被网关拦截）。
3. `max_tokens` 统一 16000（摘要类调用可用 2000，代码里注明原因）。
4. README 七节 + 顶部两行元信息 + 第 2 节至少一张 mermaid 图，目标 130–160 行。
5. 写作照 `CLAUDE.md` 的「写作边界」：段落≤3 句、结论前置、第 3 节只贴要讲的片段。
6. 去个人化：实录不许出现真实用户名和本机绝对路径。
7. 实录必须真跑，禁止为跑通改 `index.ts`。跑法：
   `http_proxy= https_proxy= all_proxy= bun run examples/NN-xxx/index.ts`
8. 中文讲解 + 中文注释；术语首次出现给英文原词。

---

### Task 1: 08-compaction —— 上下文压缩

**Files:**
- Create: `examples/08-compaction/index.ts`, `examples/08-compaction/README.md`
- Modify: `.gitignore`（忽略 `.transcripts/`）

**教学目标：** 05 课算出每轮重复率 60%，03 课看到 token 一路涨。这一课动手解决。
两种压缩：`microCompact` 每轮都做的轻量压缩，`autoCompact` 顶不住时的重手段。

**演示任务特意选「读 7 个 README」**，因为它会产生 7 个几 KB 的 `tool_result`，
不压缩的话 token 涨得非常明显——这是让效果可见的关键。

- [ ] **Step 1: 写 index.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 15;

// ---- microCompact 的三个参数 ----
const KEEP_RECENT = 2;         // 最近几个 tool_result 保持原样（模型正在用它们）
const COMPACT_THRESHOLD = 400; // 短输出压了也省不下多少，不值得
const PREVIEW_LENGTH = 120;    // 压缩后保留多少字符的预览

const SYSTEM = `你是一个在当前目录工作的编码助手。优先使用工具，做完用一句话总结。`;

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

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_file: async ({ path }) => await Bun.file(path).text(),
};

// ============ 轻量压缩：把旧的工具输出换成占位符 ============
//
// 思路：模型真正需要逐字重读的，只有最近几次工具输出。
// 更早的那些，留一句"我用 read_file 读过某文件，开头是……"就够它记得发生过什么。

function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // 1. 按出现顺序收集所有 tool_result 的 id
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result") ids.push(b.tool_use_id);
    }
  }
  if (ids.length <= KEEP_RECENT) return messages;

  // 除了最近 KEEP_RECENT 个，其余都是压缩对象
  const targets = new Set(ids.slice(0, -KEEP_RECENT));

  // 2. 建 tool_use_id → 工具名 的映射，占位符里要说清是哪个工具产生的
  const toolNames: Record<string, string> = {};
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") toolNames[b.id] = b.name;
    }
  }

  // 3. 替换。返回新数组，不改原对象
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const content = m.content.map((b) => {
      if (
        b.type === "tool_result" &&
        targets.has(b.tool_use_id) &&
        typeof b.content === "string" &&
        b.content.length > COMPACT_THRESHOLD
      ) {
        const name = toolNames[b.tool_use_id] ?? "未知工具";
        const preview = b.content.slice(0, PREVIEW_LENGTH).replace(/\n/g, " ");
        return { ...b, content: `[已压缩：${name} 的输出，开头是 "${preview}…"]` };
      }
      return b;
    });
    return { ...m, content };
  });
}

// ============ 重度压缩：让模型把整段历史总结成一段话 ============
//
// microCompact 顶不住时（历史本身就很长，不只是工具输出大）才动用。
// 原始历史先落盘，压缩是有损的，别把信息彻底丢了。

async function autoCompact(
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  const path = `.transcripts/transcript_${Date.now()}.jsonl`;
  await Bun.write(path, messages.map((m) => JSON.stringify(m)).join("\n"));
  console.log(`  原始历史已存到 ${path}`);

  // max_tokens 给 2000：我们要的是摘要，不是长篇大论
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content:
          "把下面这段对话总结成一段话，保留三件事：1) 已经完成了什么 " +
          "2) 当前进行到哪一步 3) 做过哪些关键决定。简洁但别丢关键细节。\n\n" +
          JSON.stringify(messages).slice(0, 60000),
      },
    ],
  });

  const summary =
    res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "(没有摘要)";

  // 整段历史被两条消息取代
  return [
    { role: "user", content: `[历史已压缩，原始记录见 ${path}]\n\n${summary}` },
    { role: "assistant", content: "了解，我已经掌握之前的上下文，继续。" },
  ];
}

// ============ 对照：同一个任务，压缩 vs 不压缩 ============

async function run(label: string, useCompact: boolean, task: string) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const perRound: number[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (useCompact) messages = microCompact(messages);

    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS,
    });
    perRound.push(res.usage.input_tokens);
    console.log(`  第 ${String(turn).padStart(2)} 轮  input=${String(res.usage.input_tokens).padStart(6)}`);

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

  const peak = Math.max(...perRound);
  const total = perRound.reduce((a, b) => a + b, 0);
  console.log(`  —— ${perRound.length} 轮，峰值 ${peak}，累计 ${total}`);
  return { rounds: perRound.length, peak, total };
}

// 这个任务会读 7 个 README，每个几 KB，正好把工具输出撑大
const TASK =
  "逐个读取 examples 目录下每一课的 README.md，然后告诉我每一课的标题分别是什么。";

const plain = await run("不压缩", false, TASK);
const compacted = await run("开启 microCompact", true, TASK);

console.log(`\n${"=".repeat(46)}\n对比\n${"=".repeat(46)}`);
console.log(`  峰值 input_tokens   ${plain.peak}  →  ${compacted.peak}`);
console.log(`  累计 input_tokens   ${plain.total}  →  ${compacted.total}`);
const saved = Math.round((1 - compacted.total / plain.total) * 100);
console.log(`  累计省下 ${saved}%`);

// ============ 演示重度压缩 ============
console.log(`\n${"=".repeat(46)}\nautoCompact 演示\n${"=".repeat(46)}`);
const long: Anthropic.MessageParam[] = [
  { role: "user", content: "帮我重构 src 下的工具模块" },
  { role: "assistant", content: "好的，我先看看目录结构。" },
  { role: "user", content: "已经拆成了三个文件：bash.ts、file.ts、todo.ts" },
  { role: "assistant", content: "拆分完成，接下来补测试。" },
];
const before = JSON.stringify(long).length;
const after = await autoCompact(long);
console.log(`  压缩前 ${long.length} 条消息（${before} 字符）`);
console.log(`  压缩后 ${after.length} 条消息（${JSON.stringify(after).length} 字符）`);
console.log(`\n  摘要内容：\n  ${String(after[0]!.content).replace(/\n/g, "\n  ").slice(0, 400)}`);
```

- [ ] **Step 2: 加 .gitignore 条目**

```bash
grep -q '.transcripts/' .gitignore || echo ".transcripts/" >> .gitignore
```

- [ ] **Step 3: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/08-compaction/index.ts
```

Expected：不压缩那轮的 `input_tokens` 会涨得很快（读 7 个 README，每个几 KB）；
开启压缩后峰值和累计都明显下降。最后演示 autoCompact 把 4 条消息压成 2 条。

**如果两者差距不明显**（比如模型没有逐个读完 7 个文件，而是用 bash 一次性处理了），
如实记录，并在 README 里说明：压缩的收益取决于工具输出有多大，
输出小的时候 `COMPACT_THRESHOLD` 会让它自动跳过——这本身是正确行为。

- [ ] **Step 4: 写 README.md**

七节。要点：

- **第 1 节**：接住 05 课的账——重复率 60%，其中大头是工具输出。工具输出一旦读进历史就再也不会变，却要每轮重发。
- **第 2 节**：mermaid `flowchart`，画两级压缩的触发关系：每轮先 microCompact（换占位符）→ 还是太大就 autoCompact（摘要 + 落盘）。
- **第 3 节**：三段。
  1. `microCompact` 为什么保留最近 `KEEP_RECENT` 个不动——模型正在用它们做判断，压了会失忆。
  2. 占位符为什么要带工具名和预览——只写「[已压缩]」模型会不知道自己做过什么，可能重复调用。
  3. `autoCompact` 为什么必须先落盘——摘要是有损的，原始记录得留个后路。
- **第 4 节**：贴真实输出，对比峰值和累计。
- **第 5 节**：压缩是有损的，三个代价：
  模型可能想重看被压掉的内容却看不到；autoCompact 那次摘要调用本身要花钱花时间；
  摘要质量不稳定，关键细节可能丢。所以顺序永远是先 micro 后 auto。
- **第 6 节**：官方两个原生方案。
  Context editing：`context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }`
  加 beta 头 `context-management-2025-06-27`——服务端直接清掉旧工具结果，比手写省事。
  Compaction：`{ type: "compact_20260112" }` 加 beta 头 `compact-2026-01-12`，服务端自动摘要。
  **关键提醒**：用 compaction 时必须把 `response.content` 整个追加回 messages，
  只取文字会丢掉 compaction 块，状态就断了。
  实测这两个 beta 在很多兼容端点上会被网关拦掉（400）。
- **第 7 节**：相比 03 课的循环，唯一的改动是每轮调 LLM 之前先过一遍 `microCompact`。

- [ ] **Step 5: 校验并提交**

```bash
grep -c '^## [1-7]\.' examples/08-compaction/README.md   # 7
grep -c '```mermaid' examples/08-compaction/README.md     # ≥1
bunx tsc --noEmit
git add examples/08-compaction .gitignore
git commit -m "docs: 08 课 上下文压缩"
```

---

### Task 2: 09-progressive-disclosure —— 按需加载

**Files:**
- Create: `examples/09-progressive-disclosure/index.ts`, `README.md`
- Create: `examples/09-progressive-disclosure/skills/git-commit/SKILL.md`
- Create: `examples/09-progressive-disclosure/skills/code-review/SKILL.md`
- Create: `examples/09-progressive-disclosure/skills/debugging/SKILL.md`

**教学目标：** 专业知识不能全塞进 system prompt——那是每轮都要付费的固定开销（05 课算过）。
正确做法是只放一行描述，模型觉得需要时再调工具取全文。

- [ ] **Step 1: 写三个 SKILL.md**

每个都是 `---` frontmatter（`name` + `description`）加正文。**正文要写得足够长**
（每个 60–100 行），否则演示不出「全量塞进去有多贵」。内容分别写：

`skills/git-commit/SKILL.md` —— 提交信息怎么写：一行主题句的字数、什么时候需要正文、
如何描述「为什么」而不是「改了什么」、常见反例。

`skills/code-review/SKILL.md` —— 代码审查看什么：正确性优先于风格、
如何提出可执行的意见、什么该在评论里说什么该直接改。

`skills/debugging/SKILL.md` —— 系统化调试：先复现再猜、二分定位、
读错误信息的完整栈、改一处验一处。

frontmatter 格式（三个文件一致）：

```markdown
---
name: git-commit
description: 写 git 提交信息时用。讲清主题句、正文、以及如何描述「为什么」。
---

# 正文从这里开始
...
```

- [ ] **Step 2: 写 index.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 10;

const SKILLS_DIR = join(import.meta.dir, "skills");

interface Skill {
  name: string;
  description: string;
  body: string;
}

// ============ 加载 skills 目录 ============
//
// 每个子目录一个 SKILL.md，开头是 --- 包起来的 frontmatter。
// 这里只解析 name 和 description 两个字段，够用就行。

function loadSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;

    const text = readFileSync(file, "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) continue;

    const meta: Record<string, string> = {};
    for (const line of match[1]!.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    skills.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? "(没有描述)",
      body: match[2]!.trim(),
    });
  }
  return skills;
}

const SKILLS = loadSkills(SKILLS_DIR);

// ============ 两种做法 ============

// 做法 A：全部塞进 system prompt。简单，但每一轮都在为全文付费。
function systemWithEverything(): string {
  const all = SKILLS.map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`).join("\n\n");
  return `你是一个编码助手。下面是你掌握的专业知识：\n\n${all}`;
}

// 做法 B：只放名字和描述，正文等模型开口要再给。
function systemWithIndexOnly(): string {
  const index = SKILLS.map((s) => `  - ${s.name}: ${s.description}`).join("\n");
  return `你是一个编码助手。

你可以调用 load_skill 获取专业知识的详细内容。可用的有：
${index}

遇到不熟悉的任务时，先 load_skill 取到详细指导再动手。`;
}

const LOAD_SKILL_TOOL: Anthropic.Tool = {
  name: "load_skill",
  description: "按名字加载一份专业知识的完整内容。",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "要加载的知识名字" } },
    required: ["name"],
  },
};

function loadSkillContent(name: string): string {
  const skill = SKILLS.find((s) => s.name === name);
  if (!skill) return `错误：没有叫 ${name} 的知识。可选：${SKILLS.map((s) => s.name).join(", ")}`;
  return `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
}

// ============ 对照运行 ============

async function run(label: string, system: string, tools: Anthropic.Tool[], task: string) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const perRound: number[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools,
    });
    perRound.push(res.usage.input_tokens);
    console.log(`  第 ${turn} 轮  input=${res.usage.input_tokens}`);
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      console.log(`    → ${block.name}(${JSON.stringify(block.input)})`);
      const output =
        block.name === "load_skill"
          ? loadSkillContent((block.input as any).name)
          : `错误：没有名为 ${block.name} 的工具`;
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }

  const total = perRound.reduce((a, b) => a + b, 0);
  console.log(`  —— ${perRound.length} 轮，首轮 ${perRound[0]}，累计 ${total}`);
  return { first: perRound[0]!, total, rounds: perRound.length };
}

console.log(`加载到 ${SKILLS.length} 份知识：${SKILLS.map((s) => s.name).join(", ")}`);
const fullSize = SKILLS.reduce((n, s) => n + s.body.length, 0);
console.log(`正文合计 ${fullSize} 字符\n`);

const TASK = "我刚修好一个空指针的 bug，帮我写一条 git 提交信息。";

const a = await run("A · 全部塞进 system", systemWithEverything(), [], TASK);
const b = await run("B · 只放索引，按需加载", systemWithIndexOnly(), [LOAD_SKILL_TOOL], TASK);

console.log(`\n${"=".repeat(46)}\n对比\n${"=".repeat(46)}`);
console.log(`  首轮 input_tokens   ${a.first}  →  ${b.first}`);
console.log(`  累计 input_tokens   ${a.total}  →  ${b.total}`);
console.log(`\n  A 每一轮都带着全部 ${SKILLS.length} 份知识，不管用不用得上。`);
console.log(`  B 只在模型开口要的时候，才把那一份的正文放进去。`);
```

- [ ] **Step 3: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/09-progressive-disclosure/index.ts
```

Expected：A 的首轮 `input_tokens` 明显大于 B；B 会多一轮（先 `load_skill` 再回答）。

**注意**：如果 B 的累计反而更高（因为多了一轮，且加载的那份知识也进了历史），
**如实记录并讲清楚**——这正是这一课最有价值的结论：
按需加载省的是「用不上的那些」，任务只用一份知识、总共只跑两三轮时优势不明显；
知识越多、单次任务用到的比例越小，收益越大。不要掩盖这个前提。

- [ ] **Step 4: 写 README.md**

七节。要点：

- **第 1 节**：agent 需要专业知识（提交规范、审查清单、调试方法）。直觉做法是全写进 system prompt。05 课算过账：system 每轮都重发。
- **第 2 节**：mermaid，画两条路径的对比——A 全量常驻，B 索引常驻 + 正文按需。
- **第 3 节**：三段：frontmatter 怎么解析；描述怎么写才能让模型判断要不要加载（描述里要写「什么时候用」，不是「这是什么」）；`load_skill` 的返回为什么用 `<skill>` 标签包起来。
- **第 4 节**：贴真实输出。
- **第 5 节**：**这一课的边界必须写清楚**：按需加载的收益 = 知识总量 × 用不上的比例。
  只有三份知识、任务恰好用一份时，省的不多，还多花一轮往返。
  真正的价值在知识有几十份的时候。另外描述写得不好模型就不会去加载，等于白搭。
- **第 6 节**：官方两个方向。
  Tool search：工具太多时把大部分标 `defer_loading: true`，配合
  `tool_search_tool_bm25_20251119`，模型先搜再加载——和这一课思路完全一样，
  只是对象从「知识」变成「工具定义」。注意至少要留一个工具不 defer，否则 400。
  Agent Skills：官方把这套 SKILL.md 机制产品化了，通过 `container.skills` 使用。
- **第 7 节**：新增 `load_skill` 工具和 `skills/` 目录，system prompt 从「装全文」变成「装索引」。

- [ ] **Step 5: 校验并提交**

```bash
ls examples/09-progressive-disclosure/skills/*/SKILL.md | wc -l   # 应为 3
grep -c '^## [1-7]\.' examples/09-progressive-disclosure/README.md
bunx tsc --noEmit
git add examples/09-progressive-disclosure
git commit -m "docs: 09 课 按需加载"
```

---

### Task 3: 10-memory-progress —— 外部记忆与进度

**Files:**
- Create: `examples/10-memory-progress/index.ts`, `README.md`
- Modify: `.gitignore`（忽略 `examples/10-memory-progress/PROGRESS.md`）

**教学目标：** 第 01 课讲过模型无状态。前面九课都在一次会话内解决问题，
但真实的长任务跨多次会话——进程一退，历史就没了。解法是把状态写到上下文之外。

**演示方式：一个脚本里跑两次「会话」**，第二次完全不带第一次的 `messages`，
只靠读 `PROGRESS.md` 接上。

- [ ] **Step 1: 写 index.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 12;

const PROGRESS_FILE = join(import.meta.dir, "PROGRESS.md");

const SYSTEM = `你是一个编码助手，负责一个要分多次会话完成的长任务。

## 进度文件的规矩
- 每完成一个步骤，立刻用 write_progress 更新进度。
- 进度里要写清楚：已完成什么、正在做什么、下一步做什么。
- 你随时可能被中断，下一次会话的你只能看到这个文件，看不到现在的对话。
  所以写给未来的自己看，别省略上下文。`;

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
    name: "read_progress",
    description: "读取进度文件，了解之前的会话做到哪一步了。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "write_progress",
    description: "覆盖写入进度文件。每完成一步就更新一次。",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "完整的进度内容，markdown 格式" },
      },
      required: ["content"],
    },
  },
];

const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => {
    const r = await Bun.$`sh -c ${command}`.nothrow().quiet();
    return (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
  },
  read_progress: async () => {
    if (!existsSync(PROGRESS_FILE)) return "进度文件还不存在，这是第一次会话。";
    return await Bun.file(PROGRESS_FILE).text();
  },
  write_progress: async ({ content }) => {
    await Bun.write(PROGRESS_FILE, content);
    return `进度已更新（${content.length} 字符）`;
  },
};

// 一次「会话」。注意 messages 是函数内的局部变量——
// 会话结束它就没了，这正是我们要模拟的情况。
async function session(label: string, userInput: string) {
  console.log(`\n${"=".repeat(46)}\n${label}\n${"=".repeat(46)}`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userInput }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS,
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`  [第 ${turn} 轮] ${block.text.trim().slice(0, 200)}`);
      }
    }

    if (res.stop_reason !== "tool_use") {
      console.log(`  —— 会话结束，共 ${turn} 轮`);
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      console.log(`    → ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
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
  console.log(`  —— 达到 ${MAX_TURNS} 轮上限`);
}

// 每次运行都从干净状态开始，方便反复演示
if (existsSync(PROGRESS_FILE)) {
  await Bun.$`rm -f ${PROGRESS_FILE}`.quiet();
  console.log("（已清除上次的进度文件）");
}

// ---- 第一次会话：开工，做一部分，写进度 ----
await session(
  "第 1 次会话",
  "任务：统计 examples 目录下每一课的 README.md 各有多少行。" +
    "这次会话只统计前两课，统计完把进度写下来就停。",
);

console.log(`\n${"-".repeat(46)}`);
console.log("进度文件现在的内容：");
console.log("-".repeat(46));
console.log(await Bun.file(PROGRESS_FILE).text());

// ---- 第二次会话：全新的 messages，只靠进度文件接上 ----
// 注意这里没有传任何上一次的对话内容
await session(
  "第 2 次会话（全新上下文，只有进度文件）",
  "继续之前没做完的任务。先读进度文件搞清楚做到哪了。",
);

console.log(`\n${"-".repeat(46)}`);
console.log("最终进度文件：");
console.log("-".repeat(46));
console.log(await Bun.file(PROGRESS_FILE).text());
```

- [ ] **Step 2: 加 .gitignore**

```bash
grep -q 'PROGRESS.md' .gitignore || echo "examples/10-memory-progress/PROGRESS.md" >> .gitignore
```

- [ ] **Step 3: 真跑，抓输出**

```bash
http_proxy= https_proxy= all_proxy= bun run examples/10-memory-progress/index.ts
```

Expected：第 1 次会话统计前两课并写进度；第 2 次会话在**完全没有上一次对话**的情况下，
读进度文件后接着统计剩下的课。

**关键验证点**：第 2 次会话第一个动作应该是 `read_progress`。
如果它没读就瞎猜，说明 system prompt 的约束不够——如实记录，
并在 README 里讲清楚「进度文件只有在模型真的去读它时才有用」。

- [ ] **Step 4: 写 README.md**

七节。要点：

- **第 1 节**：第 01 课讲模型无状态，我们用「每轮重发历史」解决了。但进程一退，历史就没了。真实的长任务跨天跨会话。
- **第 2 节**：mermaid `sequenceDiagram` 或 `flowchart`，画两次会话通过文件握手：会话 1 写文件 → 进程结束、messages 消失 → 会话 2 读文件 → 接上。
- **第 3 节**：三段：
  1. `session()` 里 `messages` 是局部变量——会话结束就没了，这是刻意的。
  2. system prompt 里那句「下一次会话的你只能看到这个文件」——**这是让机制生效的关键**，
     不写清楚模型不会主动维护进度。
  3. `write_progress` 为什么是全量覆盖而不是追加——追加会让文件无限增长，又变成另一个上下文膨胀问题。
- **第 4 节**：贴真实输出，重点是第 2 次会话第一步就去读了进度文件。
- **第 5 节**：三个代价：
  进度文件本身也占上下文（读进来就是 token）；
  模型可能忘记更新，导致进度和实际不符；
  全量覆盖意味着写错了就丢了历史版本（真实项目里配合 git 提交更稳）。
- **第 6 节**：官方 memory tool `{"type": "memory_20250818", "name": "memory"}`——
  把「记什么、怎么存」标准化了，模型通过统一接口读写，不用自己设计文件格式。
  Python/TypeScript SDK 还提供了 `betaMemoryTool` 帮你实现后端。
- **第 7 节**：新增 `PROGRESS.md` 和两个读写工具；结构上的变化是**一次运行里跑了两次独立会话**。

- [ ] **Step 5: 校验并提交**

```bash
grep -c '^## [1-7]\.' examples/10-memory-progress/README.md
git check-ignore examples/10-memory-progress/PROGRESS.md && echo "PROGRESS.md 已忽略"
bunx tsc --noEmit
git add examples/10-memory-progress .gitignore
git commit -m "docs: 10 课 外部记忆与进度"
```

---

### Task 4: 更新根 README 路线图

- [ ] 把 08 / 09 / 10 三行改成已完成并加链接，mermaid 里三个节点移出 `planned` 样式并入 `done`
- [ ] 校验目录存在后提交

---

## 完成标准

- [ ] 三课各有 `index.ts` + `README.md`，七节齐全、至少一张 mermaid 图
- [ ] 三课都能真跑，README 第 4 节是真实输出
- [ ] 09 课有三个 `SKILL.md`，正文足够长（各 60–100 行）
- [ ] `.transcripts/` 和 `PROGRESS.md` 已忽略，未入库
- [ ] `bunx tsc --noEmit` 零错误
- [ ] `grep -rn 'yangjie\|/Users/yangjie' examples/ README.md` 无输出
- [ ] `grep -rn 'ugreen-ai-model\|claude-opus-5' examples/*/index.ts` 无输出
- [ ] 根 README 路线图已更新
