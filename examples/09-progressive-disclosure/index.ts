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
