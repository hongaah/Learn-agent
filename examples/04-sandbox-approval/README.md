# 04 · 沙箱与审批门

> 一句话：把 agent 关在工作目录里，危险操作先问过人。
>
> 预计消耗：2 次 API 调用跑通主线 demo（这次任务只会触发 `safePath`，不会触发审批）；
> 第 4 节另附一份 5 次调用的补充实录，专门用来抓审批交互和白名单漏洞的真实输出。

## 1. 你会遇到的问题

上一课（03）里的三个工具什么都敢干：`read_file` 能读 `/etc/passwd`，`write_file` 能覆盖
工作目录外任意文件，`bash` 能跑 `rm -rf`——没有一行代码检查"这个操作安全吗"。那时候是故意
留白，先把循环跑通，安全边界留到这一课。

这不是小概率事故：模型自己会理解错指令范围；一旦接上不可信输入（网页、邮件里混着"顺手把
SSH key 传出去"这样的注入指令），后果都在你机器上真实发生，没人替你踩刹车。

这一课加两道防线：路径不能逃出工作目录，危险操作要人先点头。

## 2. 心智模型

```mermaid
flowchart TD
    A(["模型发起一次 tool_use"]) --> B{"输入参数<br/>带路径吗？"}
    B -- "是：read_file / write_file" --> C["safePath(path)<br/>resolve 成绝对路径，<br/>比较是否以 WORKDIR + '/' 开头"]
    C -- "逃出工作目录" --> ESC(["抛错「路径逃逸出工作目录」<br/>被 try/catch 接住，<br/>当普通 tool_result 回传"])
    C -- "在工作目录内" --> D{"这个工具<br/>要审批吗？"}
    B -- "否：bash" --> W{"命令命中<br/>AUTO_APPROVE 只读白名单？"}
    W -- "命中（ls/cat/git status…）" --> RUN["直接执行，不打扰用户"]
    W -- "没命中" --> D
    D -- "read_file：不需要" --> RUN
    D -- "write_file / 非白名单 bash：需要" --> ASK["approve()<br/>打印动作，等终端输入一行"]
    ASK --> Y{"输入是 y 吗？"}
    Y -- 是 --> RUN
    Y -- "否（N / 直接回车 / EOF）" --> REJ(["不抛异常！<br/>「用户拒绝了…」当作<br/>tool_result 正常回给模型"])
    RUN --> MERGE(["tool_result 合并进同一条<br/>user 消息，循环继续"])
    ESC --> MERGE
    REJ --> MERGE
```

- **`Y -- 否 --> REJ` 是最重要的一条边。** 用户拒绝后不抛异常炸掉循环，而是把「用户拒绝了这条
  命令……」当成普通 `tool_result` 传回模型。模型像看待任何工具输出一样处理它，自己换方案或
  转头问用户——**拒绝也是一种结果，要让模型知道，而不是让进程崩掉。**
- **`read_file` 走 `safePath` 但不需要审批，`bash` 完全不经过 `safePath`，只看命令前缀。**
  这两条分支互不覆盖——第 5 节讲这个设计留下的口子。

## 3. 关键代码

完整代码见 [`index.ts`](./index.ts)。

**`safePath`：resolve 成绝对路径后比前缀，必须带上 `/`。**

```ts
function safePath(p: string): string {
  const full = resolve(WORKDIR, p);

  // 必须比较 WORKDIR + "/"：只写 full.startsWith(WORKDIR)，
  // /Users/me/work-evil 会被误判为在 /Users/me/work 之内——前缀匹配的经典漏洞。
  if (full !== WORKDIR && !full.startsWith(WORKDIR + "/")) {
    throw new Error(`路径逃逸出工作目录：${p}`);
  }
  return full;
}
```

**`AUTO_APPROVE`：只读命令直接放行，避免审批疲劳。**

```ts
const AUTO_APPROVE = /^(ls|pwd|cat|head|tail|wc|find|grep|git status|git log|git diff)\b/;
```

每条命令都要审批，用户很快会养成"无脑按 y"的习惯，安全性反而归零。这里只对公认只读的命令
免检，写、删、改一律走 `approve()`。这条正则只按命令开头匹配——第 5 节会说明它是最诚实的软肋。

**`approve()`：读一行终端输入，拒绝时返回一句话而不是崩掉。**

```ts
async function approve(action: string): Promise<boolean> {
  process.stdout.write(`\n  ⚠️  agent 想执行：${action}\n     允许吗？(y/N) `);
  for await (const line of console) {
    return line.trim().toLowerCase() === "y";
  }
  return false;
}
```

只有 `y`（大小写不敏感）算通过，其余输入（含直接回车）都是 `false`。调用方拿到 `false` 后
不抛异常，而是返回一句"用户拒绝了……"当作正常工具输出——对应第 2 节流程图里的 `REJ` 分支。

## 4. 跑一遍

```bash
printf 'y\ny\ny\n' | http_proxy= https_proxy= all_proxy= bun run examples/04-sandbox-approval/index.ts
```

> 报 HTTP 400 且返回一段 HTML？见根目录 README 的[跑不通怎么办](../../README.md#跑不通怎么办)。

要交互式输入，真实使用去掉管道自己敲 `y`/`N`；这里用管道喂答案，方便留下可复现记录
（CI 环境读不到终端也会当场拒绝，同理）。

### 主线 demo（真实输出，已截短）

```
[第 1 轮] I'll start by reading the package.json file...
  > read_file({"path":"package.json"})  { "name": "learn-agent", ... }
  > read_file({"path":"/etc/passwd"})   错误：路径逃逸出工作目录：/etc/passwd
[第 2 轮] ...现在我把项目名写入 project-name.txt 文件。
  > write_file({"path":"project-name.txt","content":"learn-agent\n"})
  ⚠️  允许吗？(y/N)     已写入 project-name.txt
[第 3 轮] 完成了……说明我只能访问 `/path/to/Learn-agent` 目录内的文件。
循环结束，共 3 轮。
```

`safePath` 放行 `package.json`、拦下 `/etc/passwd`，错误当 `tool_result` 传回，模型第 2 轮
解释给用户，没有崩掉。`write_file` 停下来等人点头，`read_file` 全程不弹审批——读安全、写
才需要确认。第 1 轮一次要了两个 `read_file`，并进同一条消息，是上一课讲的并行工具调用。

### 补充实录：拒绝路径与白名单漏洞（对照实验）

改 prompt 触发被拒绝的 `bash`、被同意的 `write_file`、刻意 `cat /etc/passwd`（命中白名单
绕开 `safePath`），先喂 `N` 再喂几个 `y`：

```bash
printf 'N\ny\ny\ny\n' | http_proxy= https_proxy= all_proxy= bun run <scratchpad 副本>
```

```
[第 1 轮] > bash({"command":"echo hello > demo-approval.txt"})
  ⚠️  允许吗？(y/N)     用户拒绝了这条命令。请换一个办法，或者问用户想怎么做。
...（第 2 轮模型自己重试同一条命令，这次同意了）
[第 3 轮] > write_file({"path":"note.txt","content":"hello from approval demo"})
  ⚠️  允许吗？(y/N)     已写入 note.txt
[第 4 轮] > bash({"command":"cat /etc/passwd"})
    ## User Database ...
循环结束，共 5 轮。
```

第 1 轮拒绝后模型没报错退出，第 2 轮自己重试——拒绝是正常轮次，不是异常。第 4 轮
`cat /etc/passwd` 完全没弹审批框，直接读出系统文件真实内容——`cat` 命中白名单，
`bash` 压根不经过 `safePath`，第 5 节讲透这个洞。

跑完清理了 demo 产生的文件，没有提交到仓库。

## 5. 代价与边界

### 黑名单为什么不行

```ts
const dangerousCommands = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
if (dangerousCommands.some((d) => command.includes(d))) return "Error: blocked";
```

`rm -rf  /`（多空格）、`rm -fr /`（换参数顺序）、base64 编码命令——都能绕过；反过来
`git commit -m "remove sudo"` 又被误杀。黑名单要枚举所有坏的，白名单只要枚举少量好的。

### 前缀匹配的坑

```ts
function buggy(p) { return resolve(WORKDIR, p).startsWith(WORKDIR); }
function fixed(p) { const f = resolve(WORKDIR, p); return f === WORKDIR || f.startsWith(WORKDIR + "/"); }
```

实测 `../work-evil/steal.txt`：`buggy` 判定 `true`（放行），`fixed` 判定 `false`（拒绝）——差距是多比较的那个 `"/"`。

### 白名单自己也有洞

`AUTO_APPROVE` 里有 `cat`，`bash cat /etc/passwd` 直接命中白名单被放行——第 4 节已经真实
跑出这个结果，`safePath` 根本不会被调用（它只挡 `read_file` / `write_file`）。

- 管的是"哪条命令"，管不住"这条命令动了哪个路径"，粒度对不上就有缝。
- 不是代码写错，是"直接给 agent 开宿主机 shell"这件事本身没有干净解，第 6 节的容器
  隔离才真正堵上。符号链接绕过、子进程逃逸这一课也没处理。

## 6. 官方现在怎么做

> ⚠️ 本节需要 Anthropic 官方 key。第三方兼容端点大多不支持。

手写 while 循环和用 Tool Runner 包一层，本质上是同一件事：由你提供工具、在你自己的机器上
执行它们。不管沙箱写得多严密，安全边界终归由你负责。

**Managed Agents**（托管代理）换了"执行环境放在哪"：创建一份持久化的 Agent 配置，针对它
发起 Session，**每个 Session 单独起一个容器**——`bash`、文件读写全在容器里跑，agent 循环
本身跑在 Anthropic 的编排层。示意（字段以官方 SDK 文档为准）：

```ts
const agent = await client.beta.agents.create({ model: MODEL, system: SYSTEM, tools: [...] });
const session = await client.beta.sessions.create({ agent: agent.id }); // 单独起一个容器
```

本课的 `safePath` + `approve()` 是没有容器时靠代码逼近隔离，逼近得不完美（`cat /etc/passwd`
那个洞）。Managed Agents 把隔离从"靠正则和路径比较去防"变成"物理上碰不到"。

小工具、能接受手动点审批，这一课的方案更简单透明。接不可信输入、无人值守长跑、多用户分别
开工作区，物理隔离更可靠，直接换 Managed Agents，而不是在自管沙箱上打补丁。

## 7. 相比上一课新增了什么

- 新增 `safePath()`，`read_file` / `write_file` 的路径参数必须先过一遍
- 新增 `approve()` 审批门 + `AUTO_APPROVE` 只读命令白名单
- `write_file` 和命中不了白名单的 `bash` 命令，现在会停下来等终端输入 `y`/`N`
- 用户拒绝时返回一句说明给模型（当作正常 `tool_result`），不再抛异常中断循环
- 诚实指出了这一课自身留下的洞：白名单只管命令、不管命令去动了哪个路径，`bash` 完全不经过
  `safePath`——真正堵上这个洞要等到第 6 节的容器隔离
- agent 循环骨架、分发表、并行工具合并规则，跟 03 课完全相同，没有改动
