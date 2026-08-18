import Anthropic from "@anthropic-ai/sdk";

// Bun 会自动加载 .env，不需要 dotenv
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID as string;
const MAX_TOKENS = 16000;

// 打印模型回复的文字部分，外加这次调用的元信息
function printReply(res: Anthropic.Message, label: string) {
  console.log(`\n===== ${label} =====`);
  for (const block of res.content) {
    if (block.type === "text") console.log(block.text);
  }
  console.log(
    `  ↑ stop_reason=${res.stop_reason}` +
      ` 输入 ${res.usage.input_tokens} tokens` +
      ` / 输出 ${res.usage.output_tokens} tokens`,
  );
}

// ---------- 第 1 次：告诉它我的名字 ----------
const first = await client.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  messages: [{ role: "user", content: "我叫 hongaah。请记住我的名字。" }],
});
printReply(first, "第 1 次：告诉它我的名字");

// ---------- 第 2 次：不带历史地问它 ----------
// 这次只发新问题，不发上面那轮对话
const forgetful = await client.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  messages: [{ role: "user", content: "我叫什么名字？" }],
});
printReply(forgetful, "第 2 次：不带历史地问（它不记得）");

// ---------- 第 3 次：把历史一起传回去 ----------
// 注意 assistant 那条消息的 content 直接用上一轮返回的 first.content，
// 而不是把文字抠出来重新拼一个字符串
const remembered = await client.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  messages: [
    { role: "user", content: "我叫 hongaah。请记住我的名字。" },
    { role: "assistant", content: first.content },
    { role: "user", content: "我叫什么名字？" },
  ],
});
printReply(remembered, "第 3 次：带上历史再问（它'记得'了）");

console.log(
  "\n结论：模型本身不存任何东西。所谓'记忆'，是你每次把完整历史重新发过去。",
);
