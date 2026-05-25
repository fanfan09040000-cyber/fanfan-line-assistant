const DEFAULT_CONTENT_LIBRARY_FOLDER_ID = "1OpJZTy76lWVcGasrTJ3Jiwm95CA49HT2";

export function isContentLibraryConfigured(env = process.env) {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.GOOGLE_REFRESH_TOKEN
  );
}

export async function getContentLibraryIdeas({ limit = 4 } = {}) {
  if (!isContentLibraryConfigured()) return [];

  try {
    const auth = await getGoogleAuth();
    const { google } = await import("googleapis");
    const drive = google.drive({ version: "v3", auth });
    const slides = google.slides({ version: "v1", auth });
    const folderId = process.env.CONTENT_LIBRARY_FOLDER_ID || DEFAULT_CONTENT_LIBRARY_FOLDER_ID;

    const fileResponse = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.presentation'`,
      fields: "files(id,name,modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 6,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = fileResponse.data.files || [];
    const ideas = [];

    for (const file of files) {
      if (ideas.length >= limit) break;

      const presentation = await slides.presentations.get({
        presentationId: file.id,
        fields: "slides(pageElements(shape(text(textElements(textRun(content)))))",
      });
      ideas.push(...extractIdeasFromPresentation(presentation.data, file.name));
    }

    return ideas.slice(0, limit);
  } catch (error) {
    console.error("Content library fetch failed:", error);
    return [];
  }
}

async function getGoogleAuth() {
  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  return oauth2Client;
}

function extractIdeasFromPresentation(presentation, sourceTitle) {
  const slideTexts = (presentation.slides || [])
    .map((slide) => extractSlideText(slide))
    .filter((text) => /內容安排建議|主題範例|建議安排/.test(text));

  return slideTexts.flatMap((text) => extractIdeasFromText(text, sourceTitle));
}

function extractSlideText(slide) {
  return (slide.pageElements || [])
    .flatMap((element) => element.shape?.text?.textElements || [])
    .map((element) => element.textRun?.content || "")
    .join("")
    .replace(/\u000b/g, "\n")
    .replace(/\r/g, "\n");
}

function extractIdeasFromText(text, sourceTitle) {
  const normalized = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  const title = findFirstMatch(normalized, /^(.+?｜.+)$/m) ||
    findFirstMatch(normalized, /^(.+?內容.+)$/m) ||
    "經紀人建議主題";
  const hooks = [...normalized.matchAll(/[「『](.+?)[」』]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const suggestion = findFirstMatch(normalized, /建議安排[:：]\s*([^\n]+)/) ||
    findFirstMatch(normalized, /目標[:：]\s*([^\n]+)/) ||
    "用妳今天的狀態拍成真實分享，不要做得太像業配。";
  const references = [...normalized.matchAll(/https?:\/\/\S+/g)]
    .map((match) => match[0].replace(/[），)。]+$/g, ""))
    .slice(0, 2);

  return [{
    title: cleanIdeaText(title),
    hook: hooks[0] || suggestion,
    shots: buildShotsFromSuggestion(suggestion, references),
    category: normalized,
    sourceTitle,
  }];
}

function buildShotsFromSuggestion(suggestion, references) {
  const shots = [
    cleanIdeaText(suggestion),
    "先拍一段今天狀態的口播",
    "補 3 個生活畫面當 B-roll",
  ];

  if (references.length > 0) {
    shots.push(`Reference：${references[0]}`);
  }

  return shots.slice(0, 4);
}

function cleanIdeaText(text) {
  return text
    .replace(/^▍/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstMatch(text, regex) {
  return text.match(regex)?.[1]?.trim();
}
