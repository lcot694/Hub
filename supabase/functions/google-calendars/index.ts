import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/db.ts";
import { GoogleApiError, googleFetch, type GoogleConnection } from "../_shared/google-client.ts";
import { corsHeaders, handleCors, HttpError, json } from "../_shared/http.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250";

interface StoredConnection extends GoogleConnection {
  household_id: string;
  person_id: string;
  display_email: string | null;
  connection_state: "active" | "reconnect_required" | "disconnected";
}

interface GoogleCalendarListItem {
  id?: unknown;
  summary?: unknown;
  summaryOverride?: unknown;
  timeZone?: unknown;
  accessRole?: unknown;
}

interface StoredCalendar {
  id: string;
  google_calendar_id: string;
  display_name: string;
  time_zone: string | null;
  enabled: boolean;
  is_writable: boolean;
}

interface CalendarDependencies {
  authenticate?: typeof requireUser;
  database?: SupabaseClient;
  fetchCalendars?: typeof fetchGoogleCalendars;
}

interface CalendarUpdate {
  googleCalendarId: string;
  enabled: boolean;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function calendarToStoredRow(item: GoogleCalendarListItem) {
  const accessRole = item.accessRole;
  const calendarId = item.id;
  const summary = typeof item.summaryOverride === "string"
    ? item.summaryOverride
    : item.summary;
  if (
    typeof calendarId !== "string" || calendarId.length === 0 ||
    typeof summary !== "string" || summary.length === 0 ||
    (accessRole !== "freeBusyReader" && accessRole !== "reader" && accessRole !== "writer" && accessRole !== "owner")
  ) {
    throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid");
  }

  return {
    google_calendar_id: calendarId,
    display_name: summary,
    time_zone: typeof item.timeZone === "string" ? item.timeZone : null,
    google_access_role: accessRole,
    writable: accessRole === "owner" || accessRole === "writer",
  };
}

export function sanitizeConnection(connection: Pick<StoredConnection,
  "id" | "household_id" | "person_id" | "display_email" | "connection_state"
>) {
  return {
    id: connection.id,
    householdId: connection.household_id,
    personId: connection.person_id,
    displayEmail: connection.display_email,
    state: connection.connection_state,
  };
}

export function sanitizeCalendar(calendar: StoredCalendar) {
  return {
    id: calendar.id,
    googleCalendarId: calendar.google_calendar_id,
    summary: calendar.display_name,
    timeZone: calendar.time_zone,
    enabled: calendar.enabled,
    writable: calendar.is_writable,
  };
}

async function loadOwnedConnection(
  database: SupabaseClient,
  userId: string,
): Promise<StoredConnection | null> {
  const { data, error } = await database
    .from("google_connections")
    .select("id,user_id,household_id,person_id,display_email,connection_state,access_token_encrypted,refresh_token_encrypted,token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  if (!data) return null;

  const connection = data as StoredConnection;
  const [membership, person] = await Promise.all([
    database.from("household_members").select("household_id")
      .eq("household_id", connection.household_id).eq("user_id", userId).maybeSingle(),
    database.from("people").select("id")
      .eq("household_id", connection.household_id).eq("id", connection.person_id).maybeSingle(),
  ]);
  if (membership.error || person.error) {
    throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  }
  if (!membership.data || !person.data) {
    throw new HttpError(403, "calendar_not_allowed", "Google calendar settings are not available");
  }
  return connection;
}

async function fetchGoogleCalendars(connection: GoogleConnection): Promise<GoogleCalendarListItem[]> {
  const response = await googleFetch(connection, CALENDAR_LIST_URL);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid");
  }
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid");
  }
  return items as GoogleCalendarListItem[];
}

async function refreshCalendars(
  database: SupabaseClient,
  connection: StoredConnection,
  fetchRemoteCalendars: typeof fetchGoogleCalendars,
): Promise<void> {
  const rows = (await fetchRemoteCalendars(connection)).map(calendarToStoredRow);
  if (!rows.length) return;
  const { error } = await database.from("google_calendars").upsert(
    rows.map(({ writable: _writable, ...row }) => ({
      ...row,
      google_connection_id: connection.id,
    })),
    { onConflict: "google_connection_id,google_calendar_id" },
  );
  if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
}

async function listStoredCalendars(database: SupabaseClient, connectionId: string): Promise<StoredCalendar[]> {
  const { data, error } = await database.from("google_calendars")
    .select("id,google_calendar_id,display_name,time_zone,enabled,is_writable")
    .eq("google_connection_id", connectionId)
    .order("display_name");
  if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  return (data ?? []) as StoredCalendar[];
}

async function readUpdate(req: Request): Promise<{ personId: string; calendars: CalendarUpdate[] }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid_request", "A JSON request body is required");
  }
  const candidate = body as { personId?: unknown; calendars?: unknown };
  if (!isUuid(candidate?.personId) || !Array.isArray(candidate?.calendars)) {
    throw new HttpError(400, "invalid_request", "A person and calendar selections are required");
  }
  const calendars: CalendarUpdate[] = [];
  for (const selection of candidate.calendars) {
    const item = selection as { googleCalendarId?: unknown; enabled?: unknown };
    if (typeof item?.googleCalendarId !== "string" || item.googleCalendarId.length === 0 || typeof item.enabled !== "boolean") {
      throw new HttpError(400, "invalid_request", "Calendar selections are invalid");
    }
    calendars.push({ googleCalendarId: item.googleCalendarId, enabled: item.enabled });
  }
  if (new Set(calendars.map((calendar) => calendar.googleCalendarId)).size !== calendars.length) {
    throw new HttpError(400, "invalid_request", "Calendar selections are invalid");
  }
  return { personId: candidate.personId, calendars };
}

async function verifyPerson(
  database: SupabaseClient,
  householdId: string,
  personId: string,
): Promise<void> {
  const { data, error } = await database.from("people").select("id")
    .eq("household_id", householdId).eq("id", personId).maybeSingle();
  if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  if (!data) throw new HttpError(400, "person_not_in_household", "Person is not in the household");
}

async function applyUpdate(
  database: SupabaseClient,
  connection: StoredConnection,
  userId: string,
  update: { personId: string; calendars: CalendarUpdate[] },
): Promise<StoredConnection> {
  await verifyPerson(database, connection.household_id, update.personId);
  const connectionUpdate = await database.from("google_connections")
    .update({ person_id: update.personId })
    .eq("id", connection.id).eq("user_id", userId).eq("household_id", connection.household_id)
    .select("id,household_id,person_id,display_email,connection_state");
  if (connectionUpdate.error || !Array.isArray(connectionUpdate.data) || connectionUpdate.data.length !== 1) {
    throw new HttpError(403, "calendar_not_allowed", "Google calendar settings are not available");
  }

  for (const selection of update.calendars) {
    const { data: calendar, error: calendarError } = await database.from("google_calendars")
      .select("id").eq("google_connection_id", connection.id)
      .eq("google_calendar_id", selection.googleCalendarId).maybeSingle();
    if (calendarError) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
    if (!calendar) throw new HttpError(400, "calendar_not_available", "A selected calendar is not available");
    const { error } = await database.from("google_calendars").update({ enabled: selection.enabled })
      .eq("id", calendar.id).eq("google_connection_id", connection.id);
    if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  }
  return connectionUpdate.data[0] as StoredConnection;
}

async function responseBody(database: SupabaseClient, connection: StoredConnection | null) {
  if (!connection) return { connection: null, calendars: [] };
  const calendars = await listStoredCalendars(database, connection.id);
  return { connection: sanitizeConnection(connection), calendars: calendars.map(sanitizeCalendar) };
}

export async function handleGoogleCalendars(
  req: Request,
  dependencies: CalendarDependencies = {},
): Promise<Response> {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  let responseHeaders = new Headers({ Vary: "Origin" });
  try {
    responseHeaders = corsHeaders(req);
    if (req.method !== "GET" && req.method !== "PUT") {
      throw new HttpError(405, "method_not_allowed", "GET or PUT is required");
    }
    const authenticate = dependencies.authenticate ?? requireUser;
    const database = dependencies.database ?? createServiceClient();
    const { userId } = await authenticate(req);
    const connection = await loadOwnedConnection(database, userId);

    if (req.method === "GET") {
      if (connection?.connection_state === "active") {
        try {
          await refreshCalendars(database, connection, dependencies.fetchCalendars ?? fetchGoogleCalendars);
        } catch (error) {
          if (error instanceof GoogleApiError) {
            throw new HttpError(502, "calendar_list_failed", "Google calendars could not be loaded");
          }
          throw error;
        }
      }
      return json(200, await responseBody(database, connection), responseHeaders);
    }

    if (!connection) throw new HttpError(404, "connection_not_found", "Google connection was not found");
    const updatedConnection = await applyUpdate(database, connection, userId, await readUpdate(req));
    return json(200, await responseBody(database, updatedConnection), responseHeaders);
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code }, responseHeaders);
    return json(500, { error: "internal_error" }, responseHeaders);
  }
}

if (typeof Deno !== "undefined") {
  Deno.serve(handleGoogleCalendars);
}
