const TAIPEI_TIME_ZONE = "Asia/Taipei";

export function isCalendarConfigured(env = process.env) {
  return Boolean(
    env.GOOGLE_CALENDAR_API_URL ||
      (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN)
  );
}

export async function getCalendarEvents({ start, end }) {
  if (process.env.GOOGLE_CALENDAR_API_URL) {
    return getCalendarEventsFromEndpoint({ start, end });
  }

  if (
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  ) {
    return getCalendarEventsFromGoogleApi({ start, end });
  }

  return [];
}

async function getCalendarEventsFromEndpoint({ start, end }) {
  const url = new URL(process.env.GOOGLE_CALENDAR_API_URL);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("timeZone", TAIPEI_TIME_ZONE);

  if (process.env.GOOGLE_CALENDAR_API_SECRET) {
    url.searchParams.set("secret", process.env.GOOGLE_CALENDAR_API_SECRET);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Calendar endpoint failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const events = Array.isArray(data) ? data : data.events || [];
  return events.map(normalizeEndpointEvent).filter(Boolean).sort(compareEvents);
}

async function getCalendarEventsFromGoogleApi({ start, end }) {
  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    timeZone: TAIPEI_TIME_ZONE,
    maxResults: 20,
  });

  return (response.data.items || []).map(normalizeGoogleEvent).filter(Boolean).sort(compareEvents);
}

function normalizeEndpointEvent(event) {
  const start = event.start || event.startTime || event.start_at;
  const end = event.end || event.endTime || event.end_at;
  const title = event.title || event.summary || event.name;

  if (!start || !title) return undefined;

  return {
    title,
    start: new Date(start),
    end: end ? new Date(end) : undefined,
    location: event.location || "",
  };
}

function normalizeGoogleEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;

  if (!start || !event.summary) return undefined;

  return {
    title: event.summary,
    start: new Date(start),
    end: end ? new Date(end) : undefined,
    location: event.location || "",
  };
}

function compareEvents(a, b) {
  return a.start.getTime() - b.start.getTime();
}
