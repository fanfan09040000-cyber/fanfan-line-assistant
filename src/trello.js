const TRELLO_API_BASE_URL = "https://api.trello.com/1";

export function isTrelloConfigured(env = process.env) {
  return Boolean(env.TRELLO_API_KEY && env.TRELLO_TOKEN);
}

export async function createTrelloCard({
  name,
  desc,
  due,
  idList = process.env.TRELLO_DEFAULT_LIST_ID,
  idLabels = process.env.TRELLO_DEFAULT_LABEL_IDS,
}) {
  requireTrelloEnv(idList);

  const params = new URLSearchParams({
    key: process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
    idList,
    name,
    desc,
  });

  if (due) {
    params.set("due", due);
  }

  if (idLabels) {
    params.set("idLabels", idLabels);
  }

  const response = await fetch(`${TRELLO_API_BASE_URL}/cards?${params}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello create card failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function getBoardLists(boardId = process.env.TRELLO_BOARD_ID) {
  if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN || !boardId) {
    throw new Error("Missing TRELLO_API_KEY, TRELLO_TOKEN, or TRELLO_BOARD_ID");
  }

  const params = new URLSearchParams({
    key: process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
    fields: "name",
  });

  const response = await fetch(`${TRELLO_API_BASE_URL}/boards/${boardId}/lists?${params}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello get lists failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function getDueCards({ start, end, boardId = process.env.TRELLO_BOARD_ID }) {
  if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN || !boardId) {
    throw new Error("Missing TRELLO_API_KEY, TRELLO_TOKEN, or TRELLO_BOARD_ID");
  }

  const params = new URLSearchParams({
    key: process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
    fields: "name,due,dueComplete,url,idList,labels,dateLastActivity",
    filter: "open",
  });

  const response = await fetch(`${TRELLO_API_BASE_URL}/boards/${boardId}/cards?${params}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello get cards failed: ${response.status} ${errorText}`);
  }

  const cards = await response.json();
  const startTime = start.getTime();
  const endTime = end.getTime();

  return cards
    .filter((card) => {
      if (!card.due || card.dueComplete) return false;
      const dueTime = new Date(card.due).getTime();
      return dueTime >= startTime && dueTime < endTime;
    })
    .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
}

export async function getCardComments(cardId, limit = 3) {
  if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN || !cardId) {
    throw new Error("Missing TRELLO_API_KEY, TRELLO_TOKEN, or cardId");
  }

  const params = new URLSearchParams({
    key: process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
    filter: "commentCard",
    limit: String(limit),
  });

  const response = await fetch(`${TRELLO_API_BASE_URL}/cards/${cardId}/actions?${params}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello get comments failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function requireTrelloEnv(idList) {
  const missing = [
    ["TRELLO_API_KEY", process.env.TRELLO_API_KEY],
    ["TRELLO_TOKEN", process.env.TRELLO_TOKEN],
    ["TRELLO_DEFAULT_LIST_ID", idList],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing Trello env vars: ${missing.join(", ")}`);
  }
}
