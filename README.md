# LINE AI Assistant

用 LINE 官方帳號、GitHub、Railway 部署的個人助理 webhook。

## 功能

- 收 LINE 官方帳號文字訊息
- 呼叫 OpenAI Responses API 產生回覆
- 支援 Railway 部署
- 內建 `/health` 健康檢查

## 本機設定

```bash
npm install
cp .env.example .env
npm run dev
```

`.env` 需要填：

```bash
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.1-mini
ASSISTANT_OWNER_NAME=凡凡
PORT=3000
TRELLO_API_KEY=
TRELLO_TOKEN=
TRELLO_BOARD_ID=
TRELLO_DEFAULT_LIST_ID=
TRELLO_DEFAULT_LABEL_IDS=
LINE_TARGET_USER_ID=
CRON_SECRET=
```

## LINE 設定

1. 到 LINE Official Account Manager 建立官方帳號。
2. 啟用 Messaging API。
3. 到 LINE Developers 找到同一個 Messaging API channel。
4. 複製 `Channel secret` 和 `Channel access token`。
5. Railway 部署後，把 webhook URL 設成：

```text
https://你的-railway-domain.up.railway.app/webhook
```

6. 開啟 `Use webhook`。
7. 關閉或調整 LINE 後台自動回覆，避免跟 AI 回覆打架。

## Railway 部署

1. 把這個資料夾 push 到 GitHub repo。
2. 到 Railway 建立 New Project。
3. 選 `Deploy from GitHub repo`。
4. 在 Railway 的 Variables 加上：

```bash
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
OPENAI_API_KEY
OPENAI_MODEL
ASSISTANT_OWNER_NAME
```

5. Deploy 完成後，打開 Railway 產生的公開 domain。
6. 把 `https://你的-domain/webhook` 貼回 LINE Developers webhook URL。

## 測試

在 LINE 傳：

```text
說明
```

如果回傳功能列表，就代表 webhook 已經接通。

## Trello

Trello API 需要 `API key` 和 `token`。官方說明：

- https://support.atlassian.com/trello/docs/getting-started-with-trello-rest-api/
- https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/

### 取得清單 ID

Railway 設定好 `TRELLO_API_KEY`、`TRELLO_TOKEN`、`TRELLO_BOARD_ID` 後，在 LINE 傳：

```text
Trello lists
```

助理會回傳看板裡每個清單的 ID。把妳想預設新增卡片的清單 ID 放進：

```text
TRELLO_DEFAULT_LIST_ID
```

### 建立合作卡片

在 LINE 傳：

```text
合作：品牌名稱 / 產品名稱 / 2026-06-01 / Reels 1 支，限動 3 則
```

助理會在預設 Trello 清單建立一張卡片。

### 查看待完成任務

在 LINE 傳：

```text
今天任務
```

助理會回傳今天到期的 Trello 卡片，並附上最新留言。

在 LINE 傳：

```text
本週任務
```

助理會回傳本週到期的 Trello 卡片，並附上最新留言。
