# 03 · 循环起来

> 一句话：把"调用→执行→回填"包进 while 循环，agent 就能自己走完多步任务。
>
> 预计消耗：4～8 次 API 调用（取决于模型分几步做完）

## 1. 你会遇到的问题

上一课写死两轮，只够应付一步就能搞定的任务。真实任务往往要好几步——先 `ls` 看目录，再 `cat` 一个文件，再基于内容改点东西，后一步依赖前一步的结果。

步数你事先不知道，只有模型自己在每轮结束时知道"还要不要继续用工具"。这一课把写死的两轮换成一个循环：不停转，直到模型说"说完了"才停。

## 2. 心智模型

```mermaid
flowchart TD
    A(["messages = [一条 user 消息]"]) --> B["发起第 turn 轮请求<br/>把完整 messages 发给模型"]
    B --> C["把这轮回复存进 messages<br/>role: assistant"]
    C --> D{"stop_reason<br/>是 tool_use 吗？"}
    D -- 否 --> E(["退出循环<br/>返回模型的最终回答"])
    D -- 是 --> F["执行这一轮所有 tool_use 块<br/>（可能不止一个）"]
    F --> G["把全部 tool_result 合并成<br/>同一条 user 消息"]
    G --> H{"轮数已经<br/>达到 MAX_TURNS？"}
    H -- "否，turn + 1" --> B
    H -- 是 --> I(["强制停止<br/>防止模型陷入死循环烧钱"])
```

`MAX_TURNS`（图中 H 判断）跟"模型想不想停"无关，是你单方面加的保险丝——没有它，模型一旦陷入死循环会一直转下去，每转一圈都在真实地烧 API 调用，没有东西能让它自己刹车。

## 3. 关键代码

完整代码见 [`index.ts`](./index.ts)。

```ts
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const res = await client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools: TOOLS });
  messages.push({ role: "assistant", content: res.content });

  if (res.stop_reason !== "tool_use") return; // 排除法：max_tokens 等其余取值也退出
  // ……执行工具、回填结果
}
```

判断条件是 `!== "tool_use"` 而不是 `=== "end_turn"`：`stop_reason` 还可能是 `max_tokens`（被截断）等取值，这些情况也没有"要工具"的意思，同样该退出。

三个工具用分发表按名字派发，加新工具只多一行：

```ts
const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  bash: async ({ command }) => { /* ... */ },
  read_file: async ({ path }) => { /* ... */ },
  write_file: async ({ path, content }) => { /* ... */ },
};

const handler = toolHandlers[block.name]; // noUncheckedIndexedAccess：类型是"函数 | undefined"
if (!handler) output = `错误：没有名为 ${block.name} 的工具`; // 编译器强制要求先判空，不判空编译不过
```

工具报错要接住、回填给模型，不能让进程崩掉：

```ts
try {
  output = await handler(block.input);
} catch (e: any) {
  output = `错误：${e.message}`; // 模型看到错误文本会自己换个办法，比如先 ls 确认路径
}
```

一轮里所有 `tool_result` 必须合并进**同一条** user 消息，不能一个工具一条：

```ts
const results: Anthropic.ToolResultBlockParam[] = [];
for (const block of res.content) {
  if (block.type !== "tool_use") continue;
  // ……执行，push 进 results
}
messages.push({ role: "user", content: results }); // 一次性发，不要拆成多条
```

模型一次回复可能同时发起多个 `tool_use`（比如同时读三个文件）。拆成多条会让模型看到"一次问了三件事、却被分开回复"，它会据此学乖，以后不敢并行——退化成一次只要一个工具，白白丢掉并行的速度。

## 4. 跑一遍

```bash
bun run examples/03-tool-loop/index.ts
```

> 报 HTTP 400 且返回一段 HTML？见根目录 README 的[跑不通怎么办](../../README.md#跑不通怎么办)。

真实终端输出（未经修改，直接粘贴）：

```
[第 1 轮] 输入 469 tokens / 输出 55 tokens
  > bash({"command":"find . -name \"*.md\" -type f | sort"})
    ./.superpowers/sdd/progress.md
    ./.superpowers/sdd/task-1-brief.md
    ...

[第 2 轮] 输入 984 tokens / 输出 59 tokens
  > bash({"command":"find . -name \"*.md\" -type f | sort > md-list.txt"})
    (没有输出)

[第 3 轮] 输入 1056 tokens / 输出 49 tokens
  > bash({"command":"wc -l < md-list.txt"})
    33

[第 4 轮] 输入 1117 tokens / 输出 41 tokens
  已完成。当前目录下共有 **33 个 .md 文件**，文件名列表已写入 `md-list.txt` 文件中（包含 `node_modules` 等子目录下的文件）。

循环结束，共 4 轮。stop_reason=end_turn
```

跑完确认 `md-list.txt` 确实生成，33 行，跟第 3 轮 `wc -l` 对得上。

- **4 轮全程只用了 `bash`。** `read_file` / `write_file` 定义都发给了模型，但它选择用 `find ... | sort > md-list.txt` 直接重定向写文件，一次都没调用另外两个工具。工具列表是"允许模型用什么"，不是"必须都用一遍"。
- **每轮都只要了一个工具，没出现并行。** 这次任务强顺序（数量依赖文件先写完），换一个"同时读 3 个配置文件"的任务才会在某轮 `res.content` 里看到多个 `tool_use` 块——代码不用改，第 3 节的规则从一开始就是按"可能有多个"写的。
- **`input_tokens` 从 469 涨到 1117，将近 2.4 倍**（469 → 984 → 1056 → 1117）。每轮发出去的 `messages` 都带着之前全部历史（含工具输出），轮数越多历史越长。对比 `output_tokens`：55 → 59 → 49 → 41，基本持平甚至略降——涨的只是"发给模型看的"那部分，不是"模型说了多少话"那部分。这条曲线第 05 课（缓存）、第 08 课（压缩）会正面处理，这一课先要求你亲眼看到它确实在涨。

## 5. 代价与边界

`MAX_TURNS` 是唯一能防止模型"陷进去"的东西。设想模型反复 `read_file` 同一个文件、每次都觉得不对劲又读一遍——没有这道上限，循环会一直转，每一圈都真实消耗一次 API 调用。

这一课只跑了 4 轮，`input_tokens` 就已经涨了 2.4 倍；如果任务复杂到需要 10 轮、20 轮呢？到那时你是在为前面所有轮次的工具输出反复付费——历史只会越滚越大，从不会自己变小。第 05 课（缓存）解决"重复内容不重复计费"，第 08 课（压缩）解决"历史不能无限变长"，这一课先把问题摆出来。

三个工具什么都敢干：`write_file` 能覆盖任意路径下的任意文件，`bash` 能跑 `rm -rf`——没有一行代码在检查"这个操作安全吗"。安全边界放到下一课处理。

## 6. 官方现在怎么做

> ⚠️ 本节需要 Anthropic 官方 key。第三方兼容端点大多不支持。

**Tool Runner** 能把整个 while 循环包掉，包括 `stop_reason` 判断、并行工具的批量执行、结果合并成一条消息——你只需要注册工具、给一个初始消息：

```ts
const runner = client.beta.messages.toolRunner({
  model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM,
  messages: [{ role: "user", content: userInput }],
  tools: [{ ...bashToolDef, run: async (input) => runBash(input.command) } /* , ... */],
  max_iterations: MAX_TURNS,
});
for await (const message of runner) console.log(message);
```

多步任务还可以打开 `thinking: { type: "adaptive" }`（模型先规划再调用工具）和 `output_config: { effort: "high" }`（减少因图省事漏步、导致轮数意外变多）。主线没用它们：有些第三方兼容端点不会把 thinking 块原样返回，要么剥离要么直接 400；第 4 节 `tool_use.id` 的 `chatcmpl-tool-` 前缀就是同一层转译留下的痕迹。为了保证每一课在任何环境下都能跑，主线只用双方都稳定支持的参数。

## 7. 相比上一课新增了什么

- 两轮写死 → `for` 循环，靠 `stop_reason` 决定何时停
- 1 个工具 → 3 个工具，分发表 `toolHandlers` 按名字派发
- 新增 `system` 系统提示词
- 新增 `MAX_TURNS` 上限，防止死循环
- 工具报错不再让进程崩溃，回传错误文本给模型
- 明确并行工具调用规则：一轮结果并进同一条 user 消息
