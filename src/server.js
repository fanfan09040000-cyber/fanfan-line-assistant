import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import {
  createTrelloCard,
  getBoardLists,
  getCardComments,
  getDueCards,
  getOpenCards,
  isTrelloConfigured,
} from "./trello.js";

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
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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

  if (isTrelloListMessage(userText)) {
    const reply = await handleTrelloLists();
    await replyText(event.replyToken, reply);
    return;
  }

  if (isTodayReminderMessage(userText)) {
    const reply = await handleTrelloReminder("today");
    await replyMessage(event.replyToken, reply);
    return;
  }

  if (isWeekReminderMessage(userText)) {
    const reply = await handleTrelloReminder("week");
    await replyMessage(event.replyToken, reply);
    return;
  }

  if (isNextWeekReminderMessage(userText)) {
    const reply = await handleTrelloReminder("nextWeek");
    await replyMessage(event.replyToken, reply);
    return;
  }

  if (isTrelloCardMessage(userText)) {
    const reply = await handleTrelloCard(userText);
    await replyText(event.replyToken, reply);
    return;
  }

  const assistantReply = await askAssistant(userText);
  await replyText(event.replyToken, assistantReply);
}

async function askAssistant(userText) {
  if (!openai) {
    return "OpenAI API key 還沒設定好，所以我目前只能收到訊息，還不能產生 AI 回覆。";
  }

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
    "合作：品牌 / 產品 / 截止日 / 備註",
    "Trello lists：列出看板清單 ID",
    "今天任務：看今天要完成的 Trello 卡片",
    "本週任務：看本週要完成的 Trello 卡片",
    "下週任務：看下週要完成的 Trello 卡片",
    "待辦：明天整理品牌報價",
    "提醒：下週三 14:00 回覆合作信",
    "brief：貼上品牌資料，我幫妳整理腳本方向",
    "腳本：幫我寫一支保養品 Reels",
    "今天摘要：整理今天要做的事",
  ].join("\n");
}

function isTrelloListMessage(text) {
  return ["trello lists", "Trello lists", "清單ID", "清單 ID"].includes(text);
}

function isTrelloCardMessage(text) {
  return text.startsWith("合作：") || text.startsWith("合作:");
}

function isTodayReminderMessage(text) {
  return ["今天任務", "今日任務", "今天提醒", "今日提醒", "今天摘要"].includes(text);
}

function isWeekReminderMessage(text) {
  return ["本週任務", "這週任務", "本周任務", "本週提醒", "這週提醒"].includes(text);
}

function isNextWeekReminderMessage(text) {
  return ["下週任務", "下周任務", "下禮拜任務", "下星期任務", "下週提醒", "下禮拜提醒"].includes(text);
}

async function handleTrelloLists() {
  if (!isTrelloConfigured()) {
    return "Trello 還沒設定好。需要先在 Railway 加 TRELLO_API_KEY、TRELLO_TOKEN、TRELLO_BOARD_ID。";
  }

  try {
    const lists = await getBoardLists();
    return [
      "這是妳 Trello 看板的清單 ID：",
      "",
      ...lists.map((list) => `${list.name}\n${list.id}`),
    ].join("\n\n");
  } catch (error) {
    console.error(error);
    return "我剛剛讀 Trello 清單失敗，通常是 API key、token 或 board ID 有問題。";
  }
}

async function handleTrelloCard(text) {
  if (!isTrelloConfigured()) {
    return "Trello 還沒設定好。需要先在 Railway 加 TRELLO_API_KEY、TRELLO_TOKEN、TRELLO_DEFAULT_LIST_ID。";
  }

  const cardInput = parseCollaborationCard(text);

  try {
    const card = await createTrelloCard(cardInput);
    return [
      "已經幫妳建立 Trello 合作卡片：",
      card.name,
      card.shortUrl,
    ].join("\n");
  } catch (error) {
    console.error(error);
    return "我剛剛建立 Trello 卡片失敗，可能是 list ID、API token 權限，或 Trello 連線有問題。";
  }
}

async function handleTrelloReminder(range) {
  if (!isTrelloConfigured() || !process.env.TRELLO_BOARD_ID) {
    return "Trello 還沒設定好。需要先在 Railway 加 TRELLO_API_KEY、TRELLO_TOKEN、TRELLO_BOARD_ID。";
  }

  try {
    const lists = await getBoardLists();
    const listNameById = new Map(lists.map((list) => [list.id, list.name]));
    const { start, end, label } = getReminderRange(range);
    const cards = await getReminderCards({ start, end });

    if (cards.length === 0) {
      return `${label}目前沒有到期的 Trello 任務。`;
    }

    const cardsWithComments = await Promise.all(
      cards.map(async (card) => {
        const comments = card.comments || (await getCardComments(card.id, 2));

        return {
          ...card,
          listName: listNameById.get(card.idList) || "未分類",
          comments,
        };
      })
    );

    return buildReminderFlex(label, cardsWithComments);
  } catch (error) {
    console.error(error);
    return "我剛剛讀 Trello 任務失敗，可能是 Trello 權限、Board ID，或 API token 有問題。";
  }
}

function buildReminderFlex(label, cards) {
  const displayCards = cards.slice(0, 10);
  const extraCount = cards.length - displayCards.length;

  return {
    type: "flex",
    altText: `${label} Trello 任務：${cards.length} 件`,
    contents: {
      type: "carousel",
      contents: [
        buildSummaryBubble(label, cards.length, extraCount),
        ...displayCards.map((card, index) => buildTaskBubble(card, index)),
      ],
    },
  };
}

function buildSummaryBubble(label, count, extraCount) {
  const extraText = extraCount > 0 ? `另有 ${extraCount} 件未顯示，請打開 Trello 查看。` : "左右滑可以看每一張任務卡。";

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      backgroundColor: "#101820",
      contents: [
        {
          type: "text",
          text: `${label}任務圖卡`,
          color: "#F7F1E5",
          size: "xl",
          weight: "bold",
        },
        {
          type: "text",
          text: `${count} 件需要留意`,
          color: "#F2C14E",
          size: "md",
          weight: "bold",
          margin: "lg",
        },
        {
          type: "text",
          text: extraText,
          color: "#C9D1D9",
          size: "sm",
          wrap: true,
          margin: "md",
        },
      ],
    },
  };
}

function buildTaskBubble(card, index) {
  const labels = card.labels?.map((item) => item.name).filter(Boolean).join("、");
  const latestComment = formatLatestComments(card.comments)[0]?.replace(/^- /, "") || "沒有最新留言";
  const inferredText = !card.due && card.inferredDueSource
    ? `依留言判斷：${card.inferredDueSource.replace(/\s+/g, " ").trim()}`
    : "";

  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "18px",
      backgroundColor: "#171717",
      contents: [
        {
          type: "text",
          text: `#${index + 1} Trello 任務`,
          color: "#A3A3A3",
          size: "xs",
          weight: "bold",
        },
        {
          type: "text",
          text: truncate(card.name, 70),
          color: "#FFFFFF",
          size: "xl",
          weight: "bold",
          wrap: true,
          margin: "sm",
        },
        {
          type: "text",
          text: `到期 ${formatTaipeiDateTime(card.due || card.inferredDue)}`,
          color: "#A3A3A3",
          size: "sm",
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "18px",
      backgroundColor: "#FFFDF7",
      contents: [
        buildInfoBox("清單", card.listName, "#F7F1E5", "#A16207"),
        buildInfoBox("到期", formatTaipeiDateTime(card.due || card.inferredDue), "#EEF2FF", "#4338CA"),
        labels ? buildInfoLine("標籤", labels) : undefined,
        inferredText
          ? {
              type: "text",
              text: truncate(inferredText, 110),
              color: "#B45309",
              size: "xs",
              wrap: true,
              margin: "md",
            }
          : undefined,
        {
          type: "box",
          layout: "vertical",
          backgroundColor: "#F3F4F6",
          cornerRadius: "8px",
          paddingAll: "10px",
          margin: "md",
          contents: [
            {
              type: "text",
              text: "最新留言",
              color: "#6B7280",
              size: "xs",
              weight: "bold",
            },
            {
              type: "text",
              text: truncate(latestComment, 150),
              color: "#111827",
              size: "sm",
              wrap: true,
              margin: "xs",
            },
          ],
        },
      ].filter(Boolean),
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#0F766E",
          action: {
            type: "uri",
            label: "打開 Trello",
            uri: card.url,
          },
        },
      ],
    },
  };
}

function buildInfoBox(label, value, backgroundColor, accentColor) {
  return {
    type: "box",
    layout: "vertical",
    backgroundColor,
    cornerRadius: "8px",
    paddingAll: "12px",
    margin: "sm",
    contents: [
      {
        type: "text",
        text: label,
        color: accentColor,
        size: "xs",
        weight: "bold",
      },
      {
        type: "text",
        text: String(value),
        color: "#111827",
        size: "lg",
        weight: "bold",
        wrap: true,
        margin: "xs",
      },
    ],
  };
}

function buildInfoLine(label, value) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    margin: "md",
    contents: [
      {
        type: "text",
        text: label,
        color: "#6B7280",
        size: "xs",
        flex: 1,
      },
      {
        type: "text",
        text: String(value),
        color: "#111827",
        size: "sm",
        flex: 4,
        wrap: true,
      },
    ],
  };
}

async function getReminderCards({ start, end }) {
  const dueCards = await getDueCards({ start, end });
  const dueCardIds = new Set(dueCards.map((card) => card.id));
  const openCards = await getOpenCards();
  const commentMatchedCards = [];

  for (const card of openCards) {
    if (dueCardIds.has(card.id)) continue;

    const comments = await getCardComments(card.id, 5);
    const matchedComment = comments.find((comment) => {
      const taskDate = parseTaskDateFromComment(comment);
      if (!taskDate) return false;
      return taskDate.getTime() >= start.getTime() && taskDate.getTime() < end.getTime();
    });

    if (matchedComment) {
      commentMatchedCards.push({
        ...card,
        inferredDue: parseTaskDateFromComment(matchedComment),
        inferredDueSource: matchedComment.data?.text || "",
        comments,
      });
    }
  }

  return [...dueCards, ...commentMatchedCards].sort((a, b) => {
    const aDue = new Date(a.due || a.inferredDue).getTime();
    const bDue = new Date(b.due || b.inferredDue).getTime();
    return aDue - bDue;
  });
}

function parseCollaborationCard(text) {
  const raw = text.replace(/^合作[:：]/, "").trim();
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  const [brand = "未命名品牌", product = "未填產品", dueText = "", ...notes] = parts;
  const due = parseDueDate(dueText);

  return {
    name: `${brand}｜${product}`,
    due,
    desc: [
      `品牌：${brand}`,
      `產品：${product}`,
      dueText ? `截止日：${dueText}` : "",
      notes.length > 0 ? `備註：${notes.join(" / ")}` : "",
      "",
      "LINE 助理自動建立。",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function parseDueDate(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const isoLike = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!isoLike) return undefined;

  const [, year, month, day] = isoLike;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    18,
    0,
    0
  ).toISOString();
}

function getReminderRange(range) {
  const today = getTaipeiToday();

  if (range === "today") {
    return {
      label: "今天",
      start: taipeiDateToUtc(today.year, today.month, today.day),
      end: taipeiDateToUtc(today.year, today.month, today.day + 1),
    };
  }

  const dayOfWeek = new Date(Date.UTC(today.year, today.month - 1, today.day, 12)).getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekOffset = range === "nextWeek" ? 7 : 0;

  return {
    label: range === "nextWeek" ? "下週" : "本週",
    start: taipeiDateToUtc(today.year, today.month, today.day + mondayOffset + weekOffset),
    end: taipeiDateToUtc(today.year, today.month, today.day + mondayOffset + weekOffset + 7),
  };
}

function getTaipeiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());

  return {
    year: Number(parts.find((part) => part.type === "year").value),
    month: Number(parts.find((part) => part.type === "month").value),
    day: Number(parts.find((part) => part.type === "day").value),
  };
}

function taipeiDateToUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, -8, 0, 0));
}

function formatReminder(label, cards) {
  const lines = [`${label} Trello 任務`, ""];

  cards.forEach((card, index) => {
    const labels = card.labels?.map((item) => item.name).filter(Boolean).join("、");
    lines.push(`${index + 1}. 任務主題：${card.name}`);
    lines.push(`清單：${card.listName}`);
    lines.push(`到期：${formatTaipeiDateTime(card.due || card.inferredDue)}`);
    if (!card.due && card.inferredDueSource) {
      lines.push(`依留言判斷：${card.inferredDueSource.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    }
    if (labels) lines.push(`標籤：${labels}`);

    const comments = formatLatestComments(card.comments);
    if (comments.length > 0) {
      lines.push("最新留言：");
      comments.forEach((comment) => lines.push(comment));
    }

    lines.push(card.url);
    lines.push("");
  });

  return lines.join("\n").trim();
}

function parseTaskDateFromComment(comment) {
  const text = comment.data?.text || "";
  if (!text.trim()) return undefined;

  const baseDate = comment.date ? new Date(comment.date) : new Date();
  return parseTaskDate(text, baseDate);
}

function parseTaskDate(text, baseDate = new Date()) {
  const normalized = text.replace(/\s+/g, "");
  const base = getTaipeiDateParts(baseDate);

  const explicitDate = parseExplicitDate(normalized, base.year);
  if (explicitDate) return explicitDate;

  const relativeDay = parseRelativeDay(normalized, base);
  if (relativeDay) return relativeDay;

  const weekday = parseRelativeWeekday(normalized, base);
  if (weekday) return weekday;

  return undefined;
}

function parseExplicitDate(text, defaultYear) {
  const yearMonthDay = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日號]?/);
  if (yearMonthDay) {
    return taipeiDateToUtc(
      Number(yearMonthDay[1]),
      Number(yearMonthDay[2]),
      Number(yearMonthDay[3])
    );
  }

  const monthDay = text.match(/(\d{1,2})[月/](\d{1,2})[日號]?/);
  if (monthDay) {
    return taipeiDateToUtc(defaultYear, Number(monthDay[1]), Number(monthDay[2]));
  }

  return undefined;
}

function parseRelativeDay(text, base) {
  const offsets = [
    ["大後天", 3],
    ["後天", 2],
    ["明天", 1],
    ["今天", 0],
    ["今日", 0],
  ];

  const matched = offsets.find(([keyword]) => text.includes(keyword));
  if (!matched) return undefined;

  return taipeiDateToUtc(base.year, base.month, base.day + matched[1]);
}

function parseRelativeWeekday(text, base) {
  const match = text.match(/(這週|本週|這禮拜|本禮拜|這星期|本星期|下週|下禮拜|下星期)([一二三四五六日天])/);
  if (!match) return undefined;

  const weekOffset = match[1].startsWith("下") ? 7 : 0;
  const targetWeekday = weekdayNumber(match[2]);
  const baseWeekday = new Date(Date.UTC(base.year, base.month - 1, base.day, 12)).getUTCDay();
  const normalizedBaseWeekday = baseWeekday === 0 ? 7 : baseWeekday;
  const dayOffset = weekOffset + targetWeekday - normalizedBaseWeekday;

  return taipeiDateToUtc(base.year, base.month, base.day + dayOffset);
}

function weekdayNumber(text) {
  return {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
  }[text];
}

function getTaipeiDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year").value),
    month: Number(parts.find((part) => part.type === "month").value),
    day: Number(parts.find((part) => part.type === "day").value),
  };
}

function formatLatestComments(comments = []) {
  return comments
    .map((comment) => {
      const author = comment.memberCreator?.fullName || comment.memberCreator?.username || "Trello";
      const text = comment.data?.text?.replace(/\s+/g, " ").trim();
      if (!text) return "";
      return `- ${author}：${text.slice(0, 120)}`;
    })
    .filter(Boolean);
}

function formatTaipeiDateTime(dateText) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(dateText));
}

async function replyText(replyToken, text) {
  await replyMessage(replyToken, text);
}

async function replyMessage(replyToken, payload) {
  if (typeof payload !== "string") {
    await lineClient.replyMessage(replyToken, payload);
    return;
  }

  const message = {
    type: "text",
    text: payload.slice(0, 5000),
  };

  await lineClient.replyMessage(replyToken, message);
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, maxLength - 1)}…`;
}

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
