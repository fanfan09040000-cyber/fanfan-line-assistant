import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-5.1-mini",
  ASSISTANT_OWNER_NAME = "凡凡",
  PORT = 3000,
} = process.env;

const missingEnv = [
  ["LINE_CHANNEL_ACCESS_TOKEN", LINE_CHANNEL_ACCESS_TOKEN],
  ["LINE_CHANNEL_SECRET", LINE_CHANNEL_SECRET],
  ["OPENAI_API_KEY", OPENAI_API_KEY],
].filter(([, value]) => !value);

if (missingEnv.length > 0) {
  console.warn(
    `Missing env vars: ${missingEnv.map(([name]) => name).join(", ")}`
  );
}

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: LINE_CHANNEL_SECRET || "",
};

const app = express();
const lineClient = new Client(lineConfig);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.get("/", (_req, res) => {
  res.status(200).send("LINE AI assistant is running.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.status(200).end();

  await Promise.all(
    req.body.events.map((event) =>
      handleEvent(event).catch((error) => {
        console.error("Webhook event failed:", error);
      })
    )
  );
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userText = event.message.text.trim();

  if (isHelpMessage(userText)) {
    await replyText(event.replyToken, buildHelpMessage());
    return;
  }

  const assistantReply = await askAssistant(userText);
  await replyText(event.replyToken, assistantReply);
}

async function askAssistant(userText) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: buildSystemPrompt(),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: userText,
          },
        ],
      },
    ],
  });

  return response.output_text?.trim() || "我有收到，但剛剛沒有整理出明確回覆。";
}

function buildSystemPrompt() {
  return [
    `你是 ${ASSISTANT_OWNER_NAME} 的 LINE 個人助理。`,
    "請使用台灣繁體中文，自然、溫暖、有效率，不使用中國用語。",
    "你的工作是協助整理待辦、行程、品牌合作 brief、Reels 腳本、IG 文案、提醒事項與生活工作規劃。",
    "如果使用者貼品牌 brief，先整理：產品重點、受眾痛點、可拍畫面、必講資訊、禁用或風險、腳本方向。",
    "如果使用者要 Reels 腳本，優先用 hook → 情緒/故事 → 重點 → 收束，並提供 V1/V2/V3 可選版本。",
    "如果使用者要記錄待辦或提醒，但缺少日期、時間或內容，請簡短追問缺少的資訊。",
    "回覆要適合 LINE 閱讀，段落短一點，不要像簡報。",
  ].join("\n");
}

function isHelpMessage(text) {
  return ["help", "Help", "說明", "功能", "怎麼用"].includes(text);
}

function buildHelpMessage() {
  return [
    "可以這樣叫我：",
    "",
    "待辦：明天整理品牌報價",
    "提醒：下週三 14:00 回覆合作信",
    "brief：貼上品牌資料，我幫妳整理腳本方向",
    "腳本：幫我寫一支保養品 Reels",
    "今天摘要：整理今天要做的事",
  ].join("\n");
}

async function replyText(replyToken, text) {
  const message = {
    type: "text",
    text: text.slice(0, 5000),
  };

  await lineClient.replyMessage(replyToken, message);
}

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
