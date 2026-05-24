import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import {
  getCalendarEvents,
  isCalendarConfigured,
} from "./calendar.js";
import {
  createTrelloCard,
  getBoardLists,
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
  LINE_TARGET_USER_ID,
  CRON_SECRET,
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

app.get("/google/auth", async (_req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(400).send("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.");
    return;
  }

  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getGoogleRedirectUri()
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  res.redirect(authUrl);
});

app.get("/google/callback", async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(400).send("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.");
    return;
  }

  if (!req.query.code) {
    res.status(400).send("Missing Google OAuth code.");
    return;
  }

  try {
    const { google } = await import("googleapis");
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      getGoogleRedirectUri()
    );
    const { tokens } = await oauth2Client.getToken(String(req.query.code));

    res.type("text/plain").send([
      "Google Calendar 授權完成。",
      "",
      "請把下面這串放到 Railway 的 GOOGLE_REFRESH_TOKEN：",
      tokens.refresh_token || "沒有拿到 refresh token，請重新從 /google/auth 授權一次。",
    ].join("\n"));
  } catch (error) {
    console.error("Google OAuth callback failed:", error);
    res.status(500).send("Google Calendar 授權失敗，請看 Railway logs。");
  }
});

app.get("/push/daily", async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    res.status(401).json({ ok: false });
    return;
  }

  if (!LINE_TARGET_USER_ID) {
    res.status(400).json({ ok: false, error: "Missing LINE_TARGET_USER_ID" });
    return;
  }

  try {
    const message = await buildDailySummaryFlex();
    await lineClient.pushMessage(LINE_TARGET_USER_ID, message);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Daily push failed:", error);
    res.status(500).json({ ok: false });
  }
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
  console.log("LINE event source:", event.source);

  if (isHelpMessage(userText)) {
    await replyText(event.replyToken, buildHelpMessage());
    return;
  }

  if (isBindReminderMessage(userText)) {
    await replyText(event.replyToken, [
      "這是妳的 LINE userId，之後要做每天 9 點主動推播會用到：",
      event.source?.userId || "這個來源沒有 userId，請用一對一聊天傳送。",
    ].join("\n"));
    return;
  }

  if (isTrelloListMessage(userText)) {
    const reply = await handleTrelloLists();
    await replyText(event.replyToken, reply);
    return;
  }

  if (isNewCollaborationMessage(userText)) {
    const reply = await handleNewCollaborations();
    await replyMessage(event.replyToken, reply);
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

  if (isNextWeekCalendarMessage(userText)) {
    const range = getReminderRange("nextWeek");
    await replyMessage(event.replyToken, await buildCalendarFlex("下週行程", range));
    return;
  }

  if (isDailySummaryMessage(userText)) {
    const reply = await buildDailySummaryFlex();
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
    "新合作：整理需要回覆留言的合作清單",
    "今天任務：看今天要完成的 Trello 卡片",
    "本週任務：看本週要完成的 Trello 卡片",
    "下週任務：看下週要完成的 Trello 卡片",
    "下週行程：看下週 Google 行事曆",
    "今日總結：三張卡片總結今日行程、今日任務、本週任務",
    "綁定提醒：取得每天 9 點推播需要的 LINE userId",
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

function isNewCollaborationMessage(text) {
  return ["新合作", "待回覆合作", "待回覆留言", "合作回覆"].includes(text);
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

function isNextWeekCalendarMessage(text) {
  return ["下週行程", "下周行程", "下禮拜行程", "下星期行程"].includes(text);
}

function isDailySummaryMessage(text) {
  return ["今日總結", "今天總結", "每日總結", "早安摘要", "今天摘要"].includes(text);
}

function isBindReminderMessage(text) {
  return ["綁定提醒", "綁定推播", "我的LINEID", "我的 LINE ID"].includes(text);
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

async function handleNewCollaborations() {
  if (!isTrelloConfigured() || !process.env.TRELLO_BOARD_ID) {
    return "Trello 還沒設定好。需要先在 Railway 加 TRELLO_API_KEY、TRELLO_TOKEN、TRELLO_BOARD_ID。";
  }

  try {
    const cards = await getNewCollaborationCards();
    return buildReplyListFlex(cards);
  } catch (error) {
    console.error(error);
    return "我剛剛讀新合作清單失敗，可能是 Trello 權限、Board ID，或 API token 有問題。";
  }
}

async function handleTrelloReminder(range) {
  if (!isTrelloConfigured() || !process.env.TRELLO_BOARD_ID) {
    return "Trello 還沒設定好。需要先在 Railway 加 TRELLO_API_KEY、TRELLO_TOKEN、TRELLO_BOARD_ID。";
  }

  try {
    const { start, end, label } = getReminderRange(range);
    const cards = await getReminderCards({ start, end });

    if (cards.length === 0) {
      return `${label}目前沒有從 Trello 時程表抓到提供貼文或上線日。`;
    }

    return buildTaskSummaryFlex(label, cards);
  } catch (error) {
    console.error(error);
    return "我剛剛讀 Trello 任務失敗，可能是 Trello 權限、Board ID，或 API token 有問題。";
  }
}

async function buildDailySummaryFlex() {
  const todayRange = getReminderRange("today");
  const weekRange = getReminderRange("week");
  const [todayEvents, replyCards, todayCards, weekCards] = await Promise.all([
    buildCalendarEventsForRange(todayRange),
    getNewCollaborationCards(),
    buildReminderCardsForRange(todayRange),
    buildReminderCardsForRange(weekRange),
  ]);

  return {
    type: "flex",
    altText: "今日總結：行程、今日任務、本週任務",
    contents: {
      type: "carousel",
      contents: [
        buildCalendarBubble("今日行程", todayEvents),
        buildTodayTaskBubble("今天任務", replyCards, todayCards),
        buildTaskSummaryBubble("本週任務", weekCards),
      ],
    },
  };
}

async function buildReminderCardsForRange(rangeInfo) {
  return getReminderCards({
    start: rangeInfo.start,
    end: rangeInfo.end,
  });
}

async function buildCalendarFlex(title, rangeInfo) {
  const events = await buildCalendarEventsForRange(rangeInfo);

  return {
    type: "flex",
    altText: `${title}：${events.length} 件`,
    contents: buildCalendarBubble(title, events),
  };
}

async function buildCalendarEventsForRange(rangeInfo) {
  if (!isCalendarConfigured()) return [];

  try {
    return await getCalendarEvents({
      start: rangeInfo.start,
      end: rangeInfo.end,
    });
  } catch (error) {
    console.error("Calendar fetch failed:", error);
    return [];
  }
}

function buildTaskSummaryFlex(label, cards) {
  return {
    type: "flex",
    altText: `${label} Trello 任務：${cards.length} 件`,
    contents: buildTaskSummaryBubble(`${label}任務`, cards),
  };
}

function buildReplyListFlex(cards) {
  return {
    type: "flex",
    altText: `新合作待回覆：${cards.length} 件`,
    contents: buildReplyListBubble("新合作待回覆", cards),
  };
}

function buildTodayTaskBubble(title, replyCards, scheduleCards) {
  const contents = [
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        buildMiniMetric("待回覆", `${replyCards.length} 件`, "#F7F1E5", "#A16207"),
        buildMiniMetric("今日時程", `${scheduleCards.length} 件`, "#EEF2FF", "#4338CA"),
      ],
    },
  ];

  if (replyCards.length > 0) {
    contents.push(buildSectionTitle("新合作待回覆"));
    contents.push(...replyCards.slice(0, 4).flatMap((card, index) => buildReplyRows(card, index)));
  }

  if (scheduleCards.length > 0) {
    contents.push(buildSectionTitle("確認合作今日時程"));
    contents.push(...scheduleCards.slice(0, 4).flatMap((card, index) => buildTaskSummaryRows(card, index)));
  }

  if (replyCards.length === 0 && scheduleCards.length === 0) {
    contents.push({
      type: "text",
      text: "今天目前沒有新合作待回覆，也沒有確認合作的今日時程。",
      color: "#6B7280",
      size: "sm",
      wrap: true,
      margin: "lg",
    });
  }

  return buildBaseBubble("fanfan Trello", title, contents);
}

function buildReplyListBubble(title, cards) {
  const contents = cards.length === 0 ? [
    {
      type: "text",
      text: "新合作目前沒有需要回覆的卡片。",
      color: "#6B7280",
      size: "sm",
      wrap: true,
    },
  ] : [
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        buildMiniMetric("待回覆", `${cards.length} 件`, "#F7F1E5", "#A16207"),
        buildMiniMetric("來源", "新合作", "#EEF2FF", "#4338CA"),
      ],
    },
    ...cards.slice(0, 8).flatMap((card, index) => buildReplyRows(card, index)),
  ];

  return buildBaseBubble("fanfan Trello", title, contents);
}

function buildBaseBubble(eyebrow, title, contents) {
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
          text: eyebrow,
          color: "#A3A3A3",
          size: "xs",
        },
        {
          type: "text",
          text: title,
          color: "#FFFFFF",
          size: "xl",
          weight: "bold",
          wrap: true,
          margin: "sm",
        },
        {
          type: "text",
          text: `${formatTaipeiFullDate(new Date())} 更新`,
          color: "#A3A3A3",
          size: "sm",
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      backgroundColor: "#FFFDF7",
      contents,
    },
  };
}

function buildTaskSummaryBubble(title, cards) {
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
          text: "fanfan Trello",
          color: "#A3A3A3",
          size: "xs",
        },
        {
          type: "text",
          text: title,
          color: "#FFFFFF",
          size: "xl",
          weight: "bold",
          wrap: true,
          margin: "sm",
        },
        {
          type: "text",
          text: `${formatTaipeiFullDate(new Date())} 更新`,
          color: "#A3A3A3",
          size: "sm",
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      backgroundColor: "#FFFDF7",
      contents: (cards.length === 0 ? [
        {
          type: "text",
          text: "目前沒有抓到需要完成的任務。",
          color: "#6B7280",
          size: "sm",
          wrap: true,
        },
      ] : [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            buildMiniMetric("任務", `${cards.length} 件`, "#F7F1E5", "#A16207"),
            buildMiniMetric("來源", "Trello", "#EEF2FF", "#4338CA"),
          ],
        },
        ...cards.slice(0, 6).flatMap((card, index) => buildTaskSummaryRows(card, index)),
        cards.length > 6
          ? {
              type: "text",
              text: `另有 ${cards.length - 6} 件未顯示，請打開 Trello 查看。`,
              color: "#6B7280",
              size: "xs",
              wrap: true,
              margin: "md",
            }
          : undefined,
      ]).filter(Boolean),
    },
  };
}

function buildSectionTitle(text) {
  return {
    type: "text",
    text,
    color: "#111827",
    size: "sm",
    weight: "bold",
    margin: "lg",
  };
}

function buildCalendarBubble(title, events) {
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
          text: "fanfan Calendar",
          color: "#A3A3A3",
          size: "xs",
        },
        {
          type: "text",
          text: title,
          color: "#FFFFFF",
          size: "xl",
          weight: "bold",
          wrap: true,
          margin: "sm",
        },
        {
          type: "text",
          text: `${formatTaipeiFullDate(new Date())} 更新`,
          color: "#A3A3A3",
          size: "sm",
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      backgroundColor: "#FFFDF7",
      contents: (events.length === 0 ? [
        {
          type: "text",
          text: isCalendarConfigured()
            ? "這段時間目前沒有抓到 Google 行事曆。"
            : "Google Calendar 還沒完成授權設定，所以這張卡目前沒有行程資料。",
          color: "#6B7280",
          size: "sm",
          wrap: true,
        },
      ] : [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            buildMiniMetric("行程", `${events.length} 件`, "#F7F1E5", "#A16207"),
            buildMiniMetric("來源", "Google", "#EEF2FF", "#4338CA"),
          ],
        },
        ...events.slice(0, 8).flatMap((event, index) => buildCalendarRows(event, index)),
        events.length > 8
          ? {
              type: "text",
              text: `另有 ${events.length - 8} 件未顯示，請打開 Google 行事曆查看。`,
              color: "#6B7280",
              size: "xs",
              wrap: true,
              margin: "md",
            }
          : undefined,
      ]).filter(Boolean),
    },
  };
}

function buildMiniMetric(label, value, backgroundColor, accentColor) {
  return {
    type: "box",
    layout: "vertical",
    backgroundColor,
    cornerRadius: "8px",
    paddingAll: "10px",
    flex: 1,
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
        text: value,
        color: "#111827",
        size: "xl",
        weight: "bold",
        margin: "xs",
      },
    ],
  };
}

function buildTaskSummaryRows(card, index) {
  const provideText = formatProvideItems(card.schedule.relevantProvideItems);
  const publishText = card.schedule.relevantPublishDate
    ? formatScheduleDate(card.schedule.relevantPublishDate)
    : "不在這段時間";

  return [
    {
      type: "separator",
      margin: index === 0 ? "lg" : "md",
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      contents: [
        {
          type: "text",
          text: `${index + 1}. ${truncate(card.name, 60)}`,
          color: "#111827",
          size: "sm",
          weight: "bold",
          wrap: true,
        },
        {
          type: "text",
          text: `提供：${provideText}`,
          color: "#6B7280",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
        {
          type: "text",
          text: `上線日：${publishText}`,
          color: "#374151",
          size: "xs",
          wrap: true,
          margin: "xs",
        },
      ].filter(Boolean),
    },
  ];
}

function buildReplyRows(card, index) {
  return [
    {
      type: "separator",
      margin: index === 0 ? "lg" : "md",
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      contents: [
        {
          type: "text",
          text: `${index + 1}. ${truncate(card.name, 60)}`,
          color: "#111827",
          size: "sm",
          weight: "bold",
          wrap: true,
        },
        {
          type: "text",
          text: "要回覆經紀人留言：是否接案 / 條件 / 可討論時間",
          color: "#6B7280",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
      ],
    },
  ];
}

function buildCalendarRows(event, index) {
  return [
    {
      type: "separator",
      margin: index === 0 ? "lg" : "md",
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      contents: [
        {
          type: "text",
          text: `${formatCalendarEventDate(event.start)} ${formatCalendarEventTime(event)} ${truncate(event.title, 56)}`,
          color: "#111827",
          size: "sm",
          weight: "bold",
          wrap: true,
        },
        event.location
          ? {
              type: "text",
              text: truncate(event.location, 72),
              color: "#6B7280",
              size: "xs",
              margin: "xs",
              wrap: true,
            }
          : undefined,
      ].filter(Boolean),
    },
  ];
}

function parseScheduleTable(desc) {
  const lines = desc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const schedule = {
    provideItems: [],
    publishDate: undefined,
    publishLabel: "",
  };

  for (const line of lines) {
    if (/^[-|:\s]+$/.test(line)) continue;

    if (isProvideScheduleLine(line)) {
      const date = parseScheduleDate(line);
      if (date) {
        schedule.provideItems.push({
          date,
          label: parseScheduleLabel(line) || "提供",
        });
      }
    }

    if (/上線日|上線時間|正式上線/.test(line) && !schedule.publishDate) {
      schedule.publishDate = parseScheduleDate(line);
      schedule.publishLabel = parseScheduleLabel(line) || "上線";
    }

    if (isPublishScheduleLine(line) && !schedule.publishDate) {
      schedule.publishDate = parseScheduleDate(line);
      schedule.publishLabel = parseScheduleLabel(line) || "上線";
    }
  }

  schedule.provideItems.sort((a, b) => a.date.getTime() - b.date.getTime());
  return schedule;
}

function isProvideScheduleLine(line) {
  return /提供/.test(line) && !/品牌回覆|客戶回覆|回覆/.test(line);
}

function isPublishScheduleLine(line) {
  return /上線|上片/.test(line);
}

function parseScheduleLabel(line) {
  return line
    .replace(/\*\*/g, "")
    .replace(/\d{4}[/-]\d{1,2}[/-]\d{1,2}/g, "")
    .replace(/\d{4}年\d{1,2}月\d{1,2}[日號]?/g, "")
    .replace(/\d{1,2}[月/]\d{1,2}[日號]?/g, "")
    .replace(/[（(][一二三四五六日天][）)]/g, "")
    .replace(/[:：]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseScheduleDate(text) {
  const normalized = text.replace(/\s+/g, " ");
  const explicitYear = normalized.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);

  if (explicitYear) {
    return taipeiDateToUtc(
      Number(explicitYear[1]),
      Number(explicitYear[2]),
      Number(explicitYear[3]),
      Number(explicitYear[4] || 9),
      Number(explicitYear[5] || 0)
    );
  }

  const zhYear = normalized.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日號]?(?:\s*(上午|下午)?\s*(\d{1,2})[:：](\d{2}))?/);

  if (zhYear) {
    return taipeiDateToUtc(
      Number(zhYear[1]),
      Number(zhYear[2]),
      Number(zhYear[3]),
      normalizeHour(Number(zhYear[5] || 9), zhYear[4]),
      Number(zhYear[6] || 0)
    );
  }

  const thisYear = getTaipeiToday().year;
  const monthDay = normalized.match(/(\d{1,2})[月/](\d{1,2})[日號]?(?:\s*(上午|下午)?\s*(\d{1,2})[:：](\d{2}))?/);

  if (monthDay) {
    return taipeiDateToUtc(
      thisYear,
      Number(monthDay[1]),
      Number(monthDay[2]),
      normalizeHour(Number(monthDay[4] || 9), monthDay[3]),
      Number(monthDay[5] || 0)
    );
  }

  return undefined;
}

function normalizeHour(hour, meridiem) {
  if (meridiem === "下午" && hour < 12) return hour + 12;
  if (meridiem === "上午" && hour === 12) return 0;
  return hour;
}

function getScheduleSortTime(schedule) {
  return (schedule.relevantProvideItems?.[0]?.date ||
    schedule.relevantPublishDate ||
    new Date(8640000000000000)).getTime();
}

function formatScheduleDate(date) {
  if (!date) return "未填";

  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatProvideItems(items = []) {
  if (items.length === 0) return "未填";

  return items
    .slice(0, 3)
    .map((item) => `${formatScheduleDate(item.date)} ${item.label}`)
    .join("、");
}

function formatCalendarEventTime(event) {
  if (isAllDayEvent(event)) return "全天";

  const start = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(event.start);

  if (!event.end) return start;

  const end = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(event.end);

  return `${start}-${end}`;
}

function formatCalendarEventDate(date) {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const weekday = parts.find((part) => part.type === "weekday")?.value;

  return `${month}/${day}（${weekday}）`;
}

function isAllDayEvent(event) {
  return event.start.getHours() === 0 &&
    event.start.getMinutes() === 0 &&
    event.end?.getHours() === 0 &&
    event.end?.getMinutes() === 0;
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
  const [openCards, targetLists] = await Promise.all([
    getOpenCards(),
    getTargetListIds(),
  ]);
  const startTime = start.getTime();
  const endTime = end.getTime();

  return openCards
    .filter((card) => card.idList === targetLists.confirmed)
    .map((card) => ({
      ...card,
      schedule: parseScheduleTable(card.desc || ""),
    }))
    .map((card) => ({
      ...card,
      schedule: {
        ...card.schedule,
        relevantProvideItems: card.schedule.provideItems.filter((item) =>
          item.date.getTime() >= startTime && item.date.getTime() < endTime
        ),
        relevantPublishDate: isDateInRange(card.schedule.publishDate, startTime, endTime)
          ? card.schedule.publishDate
          : undefined,
      },
    }))
    .filter((card) => {
      const dates = [
        ...card.schedule.relevantProvideItems.map((item) => item.date),
        card.schedule.relevantPublishDate,
      ].filter(Boolean);
      return dates.some((date) => date.getTime() >= startTime && date.getTime() < endTime);
    })
    .sort((a, b) => getScheduleSortTime(a.schedule) - getScheduleSortTime(b.schedule));
}

function isDateInRange(date, startTime, endTime) {
  return Boolean(date && date.getTime() >= startTime && date.getTime() < endTime);
}

async function getNewCollaborationCards() {
  const [openCards, targetLists] = await Promise.all([
    getOpenCards(),
    getTargetListIds(),
  ]);

  if (!targetLists.newCollaboration) return [];

  return openCards
    .filter((card) => card.idList === targetLists.newCollaboration)
    .sort((a, b) => new Date(b.dateLastActivity).getTime() - new Date(a.dateLastActivity).getTime());
}

async function getTargetListIds() {
  const lists = await getBoardLists();

  return {
    newCollaboration: lists.find((list) => list.name === "新合作")?.id,
    confirmed: lists.find((list) => list.name === "確認合作")?.id,
  };
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
  const todayStart = taipeiDateToUtc(today.year, today.month, today.day);

  if (range === "today") {
    return {
      label: "今天",
      start: todayStart,
      end: taipeiDateToUtc(today.year, today.month, today.day + 1),
    };
  }

  const startOffset = range === "nextWeek" ? 7 : 0;
  const endOffset = range === "nextWeek" ? 14 : 7;

  return {
    label: range === "nextWeek" ? "下週" : "本週",
    start: taipeiDateToUtc(today.year, today.month, today.day + startOffset),
    end: taipeiDateToUtc(today.year, today.month, today.day + endOffset),
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

function getGoogleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI ||
    "https://fanfan-line-assistant-production.up.railway.app/google/callback";
}

function taipeiDateToUtc(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0));
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

  const bareWeekday = parseBareWeekday(normalized, base);
  if (bareWeekday) return bareWeekday;

  const monthEdge = parseMonthEdge(normalized, base);
  if (monthEdge) return monthEdge;

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

function parseBareWeekday(text, base) {
  const match = text.match(/(?:週|禮拜|星期)([一二三四五六日天])/);
  if (!match) return undefined;

  const targetWeekday = weekdayNumber(match[1]);
  const baseWeekday = new Date(Date.UTC(base.year, base.month - 1, base.day, 12)).getUTCDay();
  const normalizedBaseWeekday = baseWeekday === 0 ? 7 : baseWeekday;
  const dayOffset = targetWeekday >= normalizedBaseWeekday
    ? targetWeekday - normalizedBaseWeekday
    : targetWeekday - normalizedBaseWeekday + 7;

  return taipeiDateToUtc(base.year, base.month, base.day + dayOffset);
}

function parseMonthEdge(text, base) {
  if (text.includes("月底")) {
    return taipeiDateToUtc(base.year, base.month + 1, 0);
  }

  if (text.includes("月初")) {
    return taipeiDateToUtc(base.year, base.month, 1);
  }

  return undefined;
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

function formatCardDue(card) {
  if (card.dueLabel) return card.dueLabel;
  return formatTaipeiDateTime(card.due || card.inferredDue);
}

function formatTaipeiFullDate(date) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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
