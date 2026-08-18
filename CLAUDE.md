# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

从零手写 agent 的中文教程，面向零 agent 基础的开发者，对外分享。规划 14 课，L1（01–04）已完成。

- 设计文档（大纲、双轨 API 策略、实测能力矩阵）：`docs/superpowers/specs/2026-08-18-learn-agent-tutorial-design.md`
  每课是为讲清一个概念重写的最小版本，不从那个项目切片。

## 命令

```bash
bun run examples/01-first-call/index.ts        # 跑某一课
bunx tsc --noEmit                              # 类型检查（别指定文件名，否则忽略 tsconfig）
```

无测试、无 lint、无构建。`tsconfig.json` 只服务编辑器。

**本机有代理，直跑会被拦（HTTP 400 + HTML）。** 实测 `NO_PROXY`、`.env` 置空、
运行时 `delete process.env.http_proxy` 三种办法**全部无效**——Bun 在进程启动时就固定了代理配置：

```bash
http_proxy= https_proxy= all_proxy= bun run examples/03-tool-loop/index.ts
printf 'y\ny\ny\n' | http_proxy= https_proxy= all_proxy= bun run examples/04-sandbox-approval/index.ts
```

第二条是 04 课，它需要交互审批；非 TTY 下 `for await (const line of console)` 会立刻 EOF 当成拒绝。

## 结构约定

每课一个 `examples/NN-name/`，只有 `index.ts` + `README.md`。

**每课代码完全自包含。** agent loop 在课与课之间重复是有意的设计，**不要抽公共模块**——
读者要能单独拷走任何一课。代价由 README 第 7 节「相比上一课新增了什么」补偿。

README 固定七节，标题逐字：

```
## 1. 你会遇到的问题   ## 2. 心智模型   ## 3. 关键代码   ## 4. 跑一遍
## 5. 代价与边界   ## 6. 官方现在怎么做   ## 7. 相比上一课新增了什么
```

顶部两行元信息（一句话概述 + 预计消耗），第 2 节至少一张 mermaid 图。

## 主线代码的能力边界

只用 `model` / `max_tokens` / `messages` / `system` / `tools`——任何 Anthropic 兼容端点都支持。

`thinking`、`output_config`、`cache_control`、`betas`、`context_management` 一律只出现在
README 第 6 节，且带这行警示（逐字）：

```
> ⚠️ 本节需要 Anthropic 官方 key。第三方兼容端点大多不支持。
```

模型 ID 只从 `process.env.MODEL_ID` 读，代码里从不硬编码。

## 写作边界

以 `examples/01-first-call/README.md` 为风格样板。

- **简洁。** 段落最多 3 句；能列表/表格就不用段落；结论前置。删掉「值得注意的是」「下面是」
  「简单来说」「这里按 N 段拆开讲」这类元叙述。第 3 节不贴整段代码，只贴要讲的片段，
  其余指向 `index.ts`，解释优先写进代码注释。
- **通用。** 不假设读者的运行环境。不写「公司中转」「本教程默认走 XX」，第三方服务统称
  「第三方兼容端点」，不点名服务商。
- **去个人化。** 实录里不能出现真实用户名、本机绝对路径。用 `user` 和 `/path/to/Learn-agent`。
- **实录必须真跑。** 不许编造 token 数字、轮数、模型措辞；只允许脱敏和截短。
  跑实录必须用仓库里的真实代码——**不许为了跑通临时改 `index.ts`**，否则代码和实录对不上。

## 常见坑

- `` Bun.$`${cmd}` `` 不工作，插值会被转义成单个参数（防注入设计）。必须 `` Bun.$`sh -c ${cmd}` ``
- agent 的 bash 工具必须 `.nothrow().quiet()`，命令失败要把错误回传给模型，不能让进程崩
- `tsconfig` 开了 `noUncheckedIndexedAccess`，`toolHandlers[name]` 取值必须判空后再调用
- 提交信息用中文，`feat:` / `docs:` / `fix:` 前缀
