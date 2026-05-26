import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import {
  getCalendarEvents,
  isCalendarConfigured,
} from "./calendar.js";
import {
  getContentLibraryIdeas,
  isContentLibraryConfigured,
} from "./contentLibrary.js";
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
    scope: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/presentations.readonly",
    ],
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

app.get("/push/tomorrow", async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    res.status(401).json({ ok: false });
    return;
  }

  if (!LINE_TARGET_USER_ID) {
    res.status(400).json({ ok: false, error: "Missing LINE_TARGET_USER_ID" });
    return;
  }

  try {
    const message = await buildTomorrowSummaryFlex();
    await lineClient.pushMessage(LINE_TARGET_USER_ID, message);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Tomorrow push failed:", error);
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

  if (isTodayCalendarMessage(userText)) {
    const range = getReminderRange("today");
    await replyMessage(event.replyToken, await buildCalendarFlex("今日行程", range));
    return;
  }

  if (isTomorrowCalendarMessage(userText)) {
    const range = getReminderRange("tomorrow");
    await replyMessage(event.replyToken, await buildCalendarFlex("明日行程", range));
    return;
  }

  if (isWeekCalendarMessage(userText)) {
    const range = getReminderRange("week");
    await replyMessage(event.replyToken, await buildCalendarFlex("本週行程", range));
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

  if (isContentIdeasMessage(userText)) {
    const reply = await buildContentIdeasFlex("today");
    await replyMessage(event.replyToken, reply);
    return;
  }

  if (isTomorrowContentIdeasMessage(userText)) {
    const reply = await buildContentIdeasFlex("tomorrow");
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
    "今日行程：看今天 Google 行事曆",
    "明日行程：看明天 Google 行事曆",
    "本週行程：看本週 Google 行事曆",
    "下週行程：看下週 Google 行事曆",
    "今日總結：三張卡片總結今日行程、今日任務、本週任務",
    "今天拍什麼：依照行程和天氣給今日拍攝靈感",
    "明天拍什麼：依照明天行程和天氣給明日拍攝靈感",
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

function isTodayCalendarMessage(text) {
  return ["今日行程", "今天行程", "今日行事曆", "今天行事曆"].includes(text);
}

function isTomorrowCalendarMessage(text) {
  return ["明日行程", "明天行程", "明日行事曆", "明天行事曆"].includes(text);
}

function isWeekCalendarMessage(text) {
  return ["本週行程", "這週行程", "本周行程", "本週行事曆", "這週行事曆"].includes(text);
}

function isNextWeekCalendarMessage(text) {
  return ["下週行程", "下周行程", "下禮拜行程", "下星期行程"].includes(text);
}

function isDailySummaryMessage(text) {
  return ["今日總結", "今天總結", "每日總結", "早安摘要", "今天摘要"].includes(text);
}

function isContentIdeasMessage(text) {
  return ["今天拍什麼", "今日拍攝靈感", "拍攝靈感", "今日內容", "今天內容"].includes(text);
}

function isTomorrowContentIdeasMessage(text) {
  return ["明天拍什麼", "明日拍攝靈感", "明天拍攝靈感", "明日內容", "明天內容"].includes(text);
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
  const [todayEvents, replyCards, todayCards, weekCards, contentPlan] = await Promise.all([
    buildCalendarEventsForRange(todayRange),
    getNewCollaborationCards(),
    buildReminderCardsForRange(todayRange),
    buildReminderCardsForRange(weekRange),
    buildContentPlanForRange(todayRange),
  ]);

  return {
    type: "flex",
    altText: "今日總結：行程、任務、本週任務、拍攝靈感",
    contents: {
      type: "carousel",
      contents: [
        buildCalendarBubble("今日行程", todayEvents),
        buildTodayTaskBubble("今天任務", replyCards, todayCards),
        buildTaskSummaryBubble("本週任務", weekCards),
        buildContentIdeasBubble(contentPlan, "今日拍攝靈感", "今日"),
      ],
    },
  };
}

async function buildTomorrowSummaryFlex() {
  const tomorrowRange = getReminderRange("tomorrow");
  const [tomorrowEvents, contentPlan] = await Promise.all([
    buildCalendarEventsForRange(tomorrowRange),
    buildContentPlanForRange(tomorrowRange),
  ]);

  return {
    type: "flex",
    altText: "明日預告：行程、拍攝靈感",
    contents: {
      type: "carousel",
      contents: [
        buildCalendarBubble("明日行程", tomorrowEvents),
        buildContentIdeasBubble(contentPlan, "明日拍攝靈感", "明日"),
      ],
    },
  };
}

async function buildContentIdeasFlex(range = "today") {
  const rangeInfo = getReminderRange(range);
  const label = range === "tomorrow" ? "明日" : "今日";
  const contentPlan = await buildContentPlanForRange(rangeInfo);

  return {
    type: "flex",
    altText: `${label}拍攝靈感`,
    contents: buildContentIdeasBubble(contentPlan, `${label}拍攝靈感`, label),
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

async function buildContentPlanForRange(rangeInfo) {
  const [events, weather, libraryIdeas] = await Promise.all([
    buildCalendarEventsForRange(rangeInfo),
    getTaipeiWeatherSummary(rangeInfo.start),
    getContentLibraryIdeas({ limit: 4 }),
  ]);
  const signals = getContentSignals(events, weather);
  const freeSlot = findBestContentFreeSlot(events, rangeInfo.start);
  const ideas = pickContentIdeas(signals, libraryIdeas);

  return {
    weather,
    freeSlot,
    shootingMode: buildShootingMode(signals, freeSlot),
    easyOption: buildEasyContentOption(signals),
    storyPlan: buildStoryPlan(events, signals, rangeInfo.start),
    libraryEnabled: isContentLibraryConfigured(),
    libraryCount: libraryIdeas.length,
    ideas,
  };
}

async function getTaipeiWeatherSummary(date = new Date()) {
  const fallback = {
    label: "看行程",
    backgroundColor: "#F7F1E5",
    accentColor: "#A16207",
    summary: "天氣暫時抓不到，先用室內備案比較穩。",
    isOutdoorFriendly: false,
    isRainy: false,
    isHot: false,
  };

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", "25.033");
    url.searchParams.set("longitude", "121.5654");
    url.searchParams.set("timezone", "Asia/Taipei");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("hourly", "temperature_2m,precipitation_probability,weather_code");

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return fallback;

    const data = await response.json();
    const hours = data.hourly?.time || [];
    const temps = data.hourly?.temperature_2m || [];
    const rain = data.hourly?.precipitation_probability || [];
    const codes = data.hourly?.weather_code || [];
    const taipeiDay = formatDateKey(date);
    const daytime = hours
      .map((time, index) => ({ time, temp: temps[index], rain: rain[index], code: codes[index] }))
      .filter((item) => item.time?.startsWith(taipeiDay) && /T(09|10|11|12|13|14|15|16|17|18)/.test(item.time));

    if (daytime.length === 0) return fallback;

    const maxRain = Math.max(...daytime.map((item) => Number(item.rain || 0)));
    const maxTemp = Math.max(...daytime.map((item) => Number(item.temp || 0)));
    const isRainy = maxRain >= 45 || daytime.some((item) => Number(item.code) >= 51 && Number(item.code) <= 67);
    const isHot = maxTemp >= 31;
    const label = isRainy ? "室內佳" : isHot ? "避中午" : "可外拍";

    return {
      label,
      backgroundColor: isRainy ? "#EEF2FF" : isHot ? "#FFF7ED" : "#ECFDF5",
      accentColor: isRainy ? "#4338CA" : isHot ? "#C2410C" : "#047857",
      summary: `最高 ${Math.round(maxTemp)}°C，降雨機率 ${maxRain}%`,
      isOutdoorFriendly: !isRainy && !isHot,
      isRainy,
      isHot,
    };
  } catch (error) {
    console.error("Weather fetch failed:", error);
    return fallback;
  }
}

function getContentSignals(events, weather) {
  const titleText = events.map((event) => event.title).join(" ");

  return {
    hasSport: /健身|皮拉|WEE|wee|跑|路跑|運動|體態/.test(titleText),
    hasBeauty: /做臉|指甲|醫美|肉毒|體雕|剪|頭髮|美容|保養/.test(titleText),
    hasWork: /上線|業配|交稿|提供|拍攝|出席|活動|會議|直播|品牌|brief/i.test(titleText),
    hasDaily: /咖啡|畫畫|吃飯|午餐|晚餐|包粽子|登記|諮商|中醫|回診|牙醫|電影|生日/.test(titleText),
    isIndoorDay: weather.isRainy || weather.isHot,
    isOutdoorFriendly: weather.isOutdoorFriendly,
    eventCount: events.length,
  };
}

function findBestContentFreeSlot(events, date) {
  const today = getTaipeiDateParts(date);
  const windows = [
    { label: "早上", startHour: 9, endHour: 12 },
    { label: "下午", startHour: 13, endHour: 17 },
    { label: "晚上", startHour: 19, endHour: 21 },
  ];
  const busy = events
    .filter((event) => !isAllDayEvent(event))
    .map((event) => ({
      start: event.start.getTime(),
      end: (event.end || new Date(event.start.getTime() + 60 * 60 * 1000)).getTime(),
    }));

  const scored = windows.map((window) => {
    const start = taipeiDateToUtc(today.year, today.month, today.day, window.startHour).getTime();
    const end = taipeiDateToUtc(today.year, today.month, today.day, window.endHour).getTime();
    const hasConflict = busy.some((item) => item.start < end && item.end > start);
    return {
      ...window,
      hasConflict,
      label: hasConflict ? `${window.label}零碎` : `${window.label}可拍`,
      score: (window.endHour - window.startHour) - (hasConflict ? 3 : 0),
    };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    label: best.label,
    detail: `${String(best.startHour).padStart(2, "0")}:00-${String(best.endHour).padStart(2, "0")}:00`,
    isClean: !best.hasConflict,
  };
}

function buildShootingMode(signals, freeSlot) {
  const place = signals.isIndoorDay ? "室內拍攝優先" : "可安排室外或半戶外";
  const pace = freeSlot.isClean ? "可以拍一支完整 Reels" : "適合拍輕量素材和 Plog";
  return `${place}，${freeSlot.detail} ${pace}`;
}

function buildEasyContentOption(signals) {
  if (signals.hasSport) return "運動後 6 張 Plog、健身包裡有什麼、流汗後快速整理";
  if (signals.hasBeauty) return "變漂亮流程 Plog、拍攝前保養、今日妝容近拍";
  if (signals.hasDaily) return "咖啡廳工作 Plog、今日小狀態、生活感穿搭";
  return "GRWM、今天包包內容物、自由工作者的一小時";
}

function buildStoryPlan(events, signals, date = new Date()) {
  const weeklyTheme = getWeeklyStoryTheme(date);
  const visibleEvents = events
    .filter(isStoryFriendlyEvent)
    .slice(0, 3);
  const anchor = visibleEvents[0]?.title || weeklyTheme.primary;
  const leadMode = visibleEvents.length > 0 ? "行程優先" : "主題補內容";
  const mood = signals.hasWork
    ? "工作感但不要太硬"
    : signals.hasSport
      ? "有行動力、身體狀態"
      : signals.hasBeauty
        ? "變漂亮、照顧自己"
        : "生活感、輕鬆 diary";

  const frames = [
    {
      title: "開場",
      text: visibleEvents.length > 0
        ? `今天行程：${truncate(anchor, 18)}`
        : `今天主題：${truncate(weeklyTheme.primary, 18)}`,
      shot: visibleEvents.length > 0 ? "出門前鏡子照或行程路上畫面" : weeklyTheme.openingShot,
    },
    {
      title: "過程",
      text: visibleEvents.length > 0
        ? "行程中只抓一個漂亮片段就好"
        : signals.hasSport
        ? "讓自己先出門就贏一半"
        : signals.hasBeauty
          ? "把狀態慢慢整理回來"
          : signals.hasWork
            ? "今天先把重要的交出去"
            : "普通日子也可以有一點可愛",
      shot: pickStoryMiddleShot(signals),
    },
    {
      title: "收尾",
      text: weeklyTheme.closing,
      shot: weeklyTheme.closingShot,
    },
  ];
  const storySuggestion = visibleEvents.length > 0
    ? `先用「${truncate(anchor, 18)}」當今天限動主線，再補一則${weeklyTheme.primary}。`
    : `今天沒有適合公開的行程，直接走${weeklyTheme.primary}。`;

  return {
    mode: leadMode,
    weeklyTheme,
    suggestion: storySuggestion,
    interaction: weeklyTheme.interaction,
    summary: `${leadMode}，${mood}，${storySuggestion}`,
    frames,
  };
}

function isStoryFriendlyEvent(event) {
  const title = event.title || "";

  if (/上線|業配上線|交稿|提供|brief|合約|報價|付款|醫生|諮商|中醫|回診|牙醫|登記|會議|面談|私人|家人|地址|不公開|保密/i.test(title)) {
    return false;
  }

  if (/吃飯|午餐|晚餐|拿|取|買|繳費|雜事|處理|行政/.test(title)) {
    return false;
  }

  return /活動|出席|運動|健身|跑|皮拉|WEE|旅行|戶外|朋友|聚會|咖啡|拍攝|穿搭|做臉|指甲|頭髮|美容|保養|課程/.test(title);
}

function getWeeklyStoryTheme(date) {
  const weekday = getTaipeiWeekdayIndex(date);
  const base = WEEKLY_STORY_THEMES[weekday] || WEEKLY_STORY_THEMES[1];
  const cadence = getStoryCadence(date);

  return {
    ...base,
    cadence,
    primary: cadence ? `${base.primary}＋${cadence}` : base.primary,
  };
}

function getStoryCadence(date) {
  const { month, day } = getTaipeiDateParts(date);
  const weekNumber = Math.ceil(day / 7);
  const weekday = getTaipeiWeekdayIndex(date);

  if (weekday === 7 && month % 2 === 0 && weekNumber === 1) {
    return "QA 互動";
  }

  if (weekNumber % 2 === 0 && [2, 5, 7].includes(weekday)) {
    return "公關品互動";
  }

  return "";
}

const WEEKLY_STORY_THEMES = {
  1: {
    primary: "本週行程／身體狀態／運動安排",
    openingShot: "行事曆、運動鞋、身體狀態自拍",
    suggestion: "整理這週 2-3 個重點行程，順便講今天身體狀態和運動安排。",
    interaction: "投票：這週想看運動 / 美妝 / 日常",
    closing: "問大家這週想先看哪一類內容",
    closingShot: "投票：運動 / 美妝 / 日常",
  },
  2: {
    primary: "保養／妝容／拍攝前準備",
    openingShot: "保養品、化妝桌、素顏到完妝前後",
    suggestion: "拍一組拍攝前準備：保養、妝容細節、今天想讓狀態變好的小步驟。",
    interaction: "提問：想看妝容細節還是保養流程",
    closing: "收一個今天最有感的小準備",
    closingShot: "近拍妝感、桌面收尾、問題貼紙",
  },
  3: {
    primary: "健身／跑步／體態觀察／考教練日常",
    openingShot: "運動服、課表、訓練前自拍",
    suggestion: "記錄今天的訓練或體態觀察，用一張圖講最近身體最有感的改變。",
    interaction: "投票：今天練上半身 / 下半身 / 有氧",
    closing: "記錄今天身體哪裡比較有感",
    closingShot: "課後流汗自拍或小心得",
  },
  4: {
    primary: "穿搭／配件／包包小物／出門準備",
    openingShot: "穿搭鏡子照、包包內容物、配件近拍",
    suggestion: "用出門前 3 張圖整理今天穿搭、配件或包包小物。",
    interaction: "投票：包包 / 鞋 / 飾品哪個最加分",
    closing: "讓大家選今天最喜歡哪個小物",
    closingShot: "投票：包包 / 鞋 / 飾品",
  },
  5: {
    primary: "本週生活碎片／姐妹聊天／心情閒聊",
    openingShot: "咖啡、路上空景、自拍一句話",
    suggestion: "發本週生活碎片，搭配一段像跟姐妹聊天的心情閒聊。",
    interaction: "小盒子：這週你們過得如何",
    closing: "用一句話收這週心情",
    closingShot: "小盒子或留言互動",
  },
  6: {
    primary: "出門／戶外／朋友聚會／旅遊日常",
    openingShot: "出門穿搭、街景、朋友聚會前一刻",
    suggestion: "如果有出門就發路上、穿搭、聚會片段；沒出門就發週末生活感。",
    interaction: "投票：週末想出門還是在家充電",
    closing: "整理一張今天最喜歡的畫面",
    closingShot: "風景、合照、回家路上",
  },
  7: {
    primary: "整理房間／備品補貨／下週工作準備／QA 互動",
    openingShot: "桌面整理、補貨、下週待辦",
    suggestion: "拍整理房間、備品補貨或下週準備，讓限動有收心感。",
    interaction: "QA 或小盒子：下週想問我什麼",
    closing: "預告下週重點或開 QA",
    closingShot: "QA 貼紙、下週清單、補貨戰利品",
  },
};

function pickStoryMiddleShot(signals) {
  if (signals.hasSport) return "運動鞋、流汗、器材、課後整理";
  if (signals.hasBeauty) return "指甲、妝容、保養、髮型細節";
  if (signals.hasWork) return "電腦、brief、拍攝角落、補妝";
  if (signals.hasDaily) return "咖啡、食物、街景、手部近拍";
  return "包包內容物、桌面、穿搭細節";
}

function pickContentIdeas(signals, libraryIdeas = []) {
  const pool = [];
  const pickedLibraryIdeas = libraryIdeas
    .filter((idea) => isLibraryIdeaRelevant(idea, signals))
    .slice(0, 2);

  pool.push(...pickedLibraryIdeas);
  if (signals.hasWork) pool.push(...CONTENT_IDEAS.work);
  if (signals.hasSport) pool.push(...CONTENT_IDEAS.sport);
  if (signals.hasBeauty) pool.push(...CONTENT_IDEAS.beauty);
  if (signals.hasDaily) pool.push(...CONTENT_IDEAS.daily);
  if (signals.isIndoorDay) pool.push(...CONTENT_IDEAS.indoor);
  if (signals.isOutdoorFriendly) pool.push(...CONTENT_IDEAS.outdoor);

  pool.push(...CONTENT_IDEAS.evergreen);

  const unique = [];
  for (const idea of pool) {
    if (!unique.some((item) => item.title === idea.title)) unique.push(idea);
    if (unique.length >= 3) break;
  }

  return unique;
}

function isLibraryIdeaRelevant(idea, signals) {
  const text = `${idea.title} ${idea.hook} ${idea.category || ""}`;
  if (signals.hasSport && /體態|身形|運動|健康|健身|挑戰/.test(text)) return true;
  if (signals.hasBeauty && /保養|變漂亮|妝|髮|美容|狀態/.test(text)) return true;
  if (signals.hasWork && /工作|合作|品牌|拍攝|KOL|內容/.test(text)) return true;
  if (signals.hasDaily && /生活|日常|自我揭露|聊聊天|diary|回顧/.test(text)) return true;
  return true;
}

const CONTENT_IDEAS = {
  work: [
    {
      title: "KOL 拍攝前我會先做的 3 件小事",
      hook: "我以前以為拍業配就是把產品拍美，後來發現真正影響質感的是拍之前的準備。",
      shots: ["打開 brief", "整理桌面", "補妝近拍", "架手機", "拍完檢查素材"],
    },
    {
      title: "自由工作者今天不焦慮的工作節奏",
      hook: "接案最難的不是忙，是你要在很亂的行程裡，把自己穩住。",
      shots: ["今日行程截圖", "咖啡", "筆記本", "對鏡頭一句話", "收工畫面"],
    },
  ],
  sport: [
    {
      title: "女生練體態，不是為了變瘦而已",
      hook: "我以前也很在意體重，後來才發現體態變順，整個人的氣場會不一樣。",
      shots: ["綁頭髮", "熱身", "訓練側拍", "流汗近拍", "回家整理"],
    },
    {
      title: "不想動的日子，我怎麼讓自己先出門",
      hook: "今天不是很有動力，但我發現只要先換好衣服，事情就完成一半了。",
      shots: ["換運動服", "出門鞋", "路上空景", "第一組動作", "結尾自拍"],
    },
  ],
  beauty: [
    {
      title: "拍攝前把自己照顧回來的流程",
      hook: "我不是每天都很精緻，但要拍東西之前，我會用這幾步把狀態拉回來。",
      shots: ["洗臉或保養", "整理頭髮", "底妝近拍", "香氛或指甲", "完成妝容"],
    },
    {
      title: "變漂亮不是焦慮，是把自己放回第一順位",
      hook: "以前我會覺得保養很麻煩，現在覺得那是提醒自己慢下來的一個方式。",
      shots: ["保養品", "鏡子前", "手部細節", "穿搭細節", "出門前一秒"],
    },
  ],
  daily: [
    {
      title: "今天只有一小時，也可以拍出生活感",
      hook: "我以前很怕日常太無聊，後來發現重點不是行程，是你想說的那個觀點。",
      shots: ["走路空景", "咖啡", "桌面", "手寫字", "回家路上"],
    },
    {
      title: "自由工作者的普通一天，其實也需要被好好安排",
      hook: "沒有打卡下班之後，我才知道自己的時間更需要被保護。",
      shots: ["行事曆", "電腦", "飲料", "手機訊息", "晚上收工"],
    },
  ],
  indoor: [
    {
      title: "下雨天室內也能拍的 5 個素材",
      hook: "今天不適合外拍沒關係，室內反而很適合拍一點更貼近生活的東西。",
      shots: ["窗邊光", "梳妝台", "衣櫃", "咖啡杯", "手部近景"],
    },
  ],
  outdoor: [
    {
      title: "好天氣不要只拍風景，要拍出妳的狀態",
      hook: "如果今天有一點陽光，我會想拍的不是漂亮而已，是那種走出去後人變亮的感覺。",
      shots: ["走路背影", "陽光側臉", "穿搭全身", "街邊咖啡", "回頭笑"],
    },
  ],
  evergreen: [
    {
      title: "最近讓我比較有精神的 3 個小習慣",
      hook: "不是那種很厲害的自律，只是幾個真的有讓我比較回到狀態的小事。",
      shots: ["喝水", "整理包包", "運動鞋", "保養", "睡前畫面"],
    },
    {
      title: "30 歲前後，我對自信的理解變了",
      hook: "以前覺得自信是看起來很完美，現在覺得是我知道自己在照顧自己。",
      shots: ["對鏡自拍", "日常走路", "工作畫面", "保養細節", "自然笑"],
    },
  ],
};

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

function buildContentIdeasBubble(plan, title = "今日拍攝靈感", label = "今日") {
  const contents = [
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        buildMiniMetric("天氣", plan.weather.label, plan.weather.backgroundColor, plan.weather.accentColor),
        buildMiniMetric("空檔", plan.freeSlot.label, "#F5F3FF", "#6D28D9"),
      ],
    },
    buildInfoLine("拍攝建議", plan.shootingMode),
    buildInfoLine("輕鬆備案", plan.easyOption),
    plan.libraryCount > 0
      ? buildInfoLine("靈感庫", `已參考經紀人資料 ${plan.libraryCount} 則`)
      : undefined,
    buildInfoLine("限動主題", plan.storyPlan.weeklyTheme.primary),
    buildInfoLine("限動來源", plan.storyPlan.mode),
    buildInfoLine("限動建議", plan.storyPlan.suggestion),
    buildInfoLine("互動設計", plan.storyPlan.interaction),
    plan.storyPlan.weeklyTheme.cadence
      ? buildInfoLine("固定互動", plan.storyPlan.weeklyTheme.cadence)
      : undefined,
    buildSectionTitle(`${label} 3 個主題`),
    ...plan.ideas.flatMap((idea, index) => buildContentIdeaRows(idea, index)),
  ].filter(Boolean);

  return buildBaseBubble("fanfan Reels", title, contents);
}

function buildStoryFrameRows(frame, index) {
  return [
    {
      type: "separator",
      margin: index === 0 ? "md" : "sm",
    },
    {
      type: "box",
      layout: "vertical",
      margin: "sm",
      contents: [
        {
          type: "text",
          text: `${index + 1}. ${frame.title}：${frame.text}`,
          color: "#111827",
          size: "xs",
          weight: "bold",
          wrap: true,
        },
        {
          type: "text",
          text: `拍：${frame.shot}`,
          color: "#6B7280",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
      ],
    },
  ];
}

function buildContentIdeaRows(idea, index) {
  return [
    {
      type: "separator",
      margin: index === 0 ? "md" : "lg",
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      contents: [
        {
          type: "text",
          text: `${index + 1}. ${idea.title}`,
          color: "#111827",
          size: "sm",
          weight: "bold",
          wrap: true,
        },
        {
          type: "text",
          text: `Hook：${idea.hook}`,
          color: "#374151",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
        {
          type: "text",
          text: `畫面：${idea.shots.join("、")}`,
          color: "#6B7280",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
      ],
    },
  ];
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
    .filter((card) => !isNewCollaborationPlaceholderCard(card))
    .sort((a, b) => new Date(b.dateLastActivity).getTime() - new Date(a.dateLastActivity).getTime());
}

function isNewCollaborationPlaceholderCard(card) {
  const name = (card.name || "").trim();
  const desc = (card.desc || "").trim();
  const normalizedName = name
    .replace(/[＿－—–-]/g, "_")
    .replace(/[／/|｜]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/[。．.、，,：:；;）)】\]》>]+$/g, "");

  return /(?:^|_)品牌$/.test(normalizedName) ||
    /(?:^|_)品牌(?:名稱|名)?(?:待填|未填|待補|空白)?$/.test(normalizedName) ||
    /範本|模板|這張卡片是範本/.test(`${name}\n${desc}`);
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

  if (range === "tomorrow") {
    return {
      label: "明天",
      start: taipeiDateToUtc(today.year, today.month, today.day + 1),
      end: taipeiDateToUtc(today.year, today.month, today.day + 2),
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
  return getTaipeiDateParts(new Date());
}

function formatDateKey(date) {
  const { year, month, day } = getTaipeiDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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

function getTaipeiWeekdayIndex(date) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
  }).format(date);

  return {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  }[weekday] || 1;
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
