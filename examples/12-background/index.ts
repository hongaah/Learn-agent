import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;
const MAX_TURNS = 15;

type TaskStatus = "running" | "completed" | "failed";

interface BgTask {
  id: string;
  command: string;
  status: TaskStatus;
  output: string;
}

interface Notification {
  id: string;
  command: string;
  status: TaskStatus;
  output: string;
}

// ============ 后台任务管理 ============
//
// 关键在 run() 立刻返回一个 id，不等命令跑完。
// 命令结束时把结果塞进通知队列，等主循环下一轮来取。

class BackgroundManager {
  private tasks = new Map<string, BgTask>();
  private queue: Notification[] = [];
  private seq = 0;

  run(command: string): string {
    const id = `bg-${++this.seq}`;
    const task: BgTask = { id, command, status: "running", output: "" };
    this.tasks.set(id, task);

    const child = spawn("sh", ["-c", command], { cwd: process.cwd() });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d.toString()));
    child.stderr.on("data", (d) => (buf += d.toString()));

    child.on("close", (code) => {
      task.status = code === 0 ? "completed" : "failed";
      task.output = buf.trim().slice(0, 2000) || "(没有输出)";
      // 命令跑完了，但主循环这会儿可能正在等 API 响应。
      // 所以不能直接打断它，只能先放进队列。
      this.queue.push({ id, command, status: task.status, output: task.output });
    });

    return `后台任务 ${id} 已启动：${command}`;
  }

  check(id?: string): string {
    if (id) {
      const t = this.tasks.get(id);
      if (!t) return `错误：没有任务 ${id}`;
      return `[${t.status}] ${t.command}\n${t.output || "(还在跑)"}`;
    }
    if (this.tasks.size === 0) return "没有后台任务。";
    return [...this.tasks.values()].map((t) => `${t.id}: [${t.status}] ${t.command}`).join("\n");
  }

  // 取出并清空队列。主循环每轮开头调一次。
  drain(): Notification[] {
    const out = [...this.queue];
    this.queue = [];
    return out;
  }

  get pending(): number {
    return [...this.tasks.values()].filter((t) => t.status === "running").length;
  }
}

const BG = new BackgroundManager();

const TOOLS: Anthropic.Tool[] = [
  {
    name: "background_run",
    description: "在后台执行一条耗时的 shell 命令，立刻返回任务 id，不阻塞你继续做别的事。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的 shell 命令" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "查看后台任务的状态。不填 id 就列出全部。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string", description: "任务 id，可不填" } },
    },
  },
  {
    name: "bash",
    description: "同步执行一条 shell 命令，会等它跑完。只适合快命令。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的 shell 命令" } },
      required: ["command"],
    },
  },
];

const SYSTEM = `你是一个编码助手。

耗时的命令用 background_run 放到后台，然后继续做别的事，不要干等。
后台任务完成时，系统会用 <background-results> 把结果告诉你。`;

async function main(task: string) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // ---- 每轮开头：把完成的后台任务注入对话 ----
    //
    // 这是整节课的关键。后台任务是异步完成的，但对话是一问一答的同步结构，
    // 没有地方"插话"。做法是伪造一轮 user/assistant 交换，把结果塞进去。
    const notifs = BG.drain();
    if (notifs.length > 0) {
      const text = notifs
        .map((n) => `[${n.id}] ${n.status}：${n.command}\n${n.output}`)
        .join("\n\n");
      messages.push({ role: "user", content: `<background-results>\n${text}\n</background-results>` });
      messages.push({ role: "assistant", content: "收到后台结果。" });
      console.log(`  ⇢ 注入了 ${notifs.length} 条后台结果`);
    }

    const res = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS,
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n[第 ${turn} 轮] ${block.text.trim().slice(0, 200)}`);
      }
    }

    if (res.stop_reason !== "tool_use") {
      // 模型说完了，但后台可能还有任务没跑完——等一下再看
      if (BG.pending > 0) {
        console.log(`\n  还有 ${BG.pending} 个后台任务在跑，等 2 秒…`);
        await Bun.sleep(2000);
        if (BG.drain().length === 0 && BG.pending === 0) break;
        // 有新结果，塞回去让模型继续处理
        messages.push({ role: "user", content: "后台任务有更新，看一下 check_background。" });
        continue;
      }
      console.log(`\n  —— 结束，共 ${turn} 轮`);
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as any;
      console.log(`  → ${block.name}(${JSON.stringify(input).slice(0, 60)})`);

      let output: string;
      switch (block.name) {
        case "background_run": output = BG.run(input.command); break;
        case "check_background": output = BG.check(input.task_id); break;
        case "bash": {
          const r = await Bun.$`sh -c ${input.command}`.nothrow().quiet();
          output = (r.stdout.toString() + r.stderr.toString()).trim() || "(没有输出)";
          break;
        }
        default: output = `错误：没有名为 ${block.name} 的工具`;
      }
      console.log(`    ${output.slice(0, 120)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  console.log(`\n  —— 达到 ${MAX_TURNS} 轮上限`);
}

await main(
  "用 background_run 在后台跑 `sleep 5 && echo 后台任务跑完了`，" +
    "不要干等——趁它跑的时候，用 bash 统计一下 examples 目录下有多少个 index.ts 文件。" +
    "两件事都有结果了再告诉我。",
);
