import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/db.ts";
import { GoogleApiError, googleFetch, type GoogleConnection } from "../_shared/google-client.ts";
import { corsHeaders, handleCors, HttpError, json } from "../_shared/http.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250";

interface StoredConnection extends GoogleConnection {
  household_id: string; person_id: string; display_email: string | null;
  connection_state: "active" | "reconnect_required" | "disconnected";
}
interface GoogleCalendarListItem { id?: unknown; summary?: unknown; summaryOverride?: unknown; timeZone?: unknown; accessRole?: unknown }
interface GoogleCalendarPage { items?: unknown; nextPageToken?: unknown }
interface StoredCalendar { id: string; google_calendar_id: string; display_name: string; time_zone: string | null; enabled: boolean; is_writable: boolean }
interface CalendarUpdate { googleCalendarId: string; enabled: boolean }
interface StoredCalendarRow { google_calendar_id: string; display_name: string; time_zone: string | null; google_access_role: string; writable: boolean }

export interface CalendarStore {
  loadConnection(userId: string): Promise<StoredConnection | null>;
  replaceSnapshot(connectionId: string, userId: string, calendars: StoredCalendarRow[]): Promise<void>;
  listCalendars(connectionId: string): Promise<StoredCalendar[]>;
  applySelection(connectionId: string, userId: string, personId: string, calendars: CalendarUpdate[]): Promise<StoredConnection>;
  markReconnect(connectionId: string, userId: string): Promise<StoredConnection>;
}
export interface GoogleCalendarsDependencies {
  authenticate?: typeof requireUser; store?: CalendarStore; database?: SupabaseClient;
  fetchCalendarPage?: (connection: GoogleConnection, pageUrl: string) => Promise<GoogleCalendarPage>;
}

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value); }

export function calendarToStoredRow(item: GoogleCalendarListItem): StoredCalendarRow {
  const calendarId = item.id;
  const summary = typeof item.summaryOverride === "string" ? item.summaryOverride : item.summary;
  const accessRole = item.accessRole;
  if (typeof calendarId !== "string" || !calendarId || typeof summary !== "string" || !summary ||
    !["freeBusyReader", "reader", "writer", "owner"].includes(accessRole as string)) {
    throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid");
  }
  return { google_calendar_id: calendarId, display_name: summary, time_zone: typeof item.timeZone === "string" ? item.timeZone : null,
    google_access_role: accessRole as string, writable: accessRole === "owner" || accessRole === "writer" };
}

export function sanitizeConnection(connection: Pick<StoredConnection, "id" | "household_id" | "person_id" | "display_email" | "connection_state">) {
  return { id: connection.id, householdId: connection.household_id, personId: connection.person_id, displayEmail: connection.display_email, state: connection.connection_state };
}
export function sanitizeCalendar(calendar: StoredCalendar) {
  return { id: calendar.id, googleCalendarId: calendar.google_calendar_id, summary: calendar.display_name, timeZone: calendar.time_zone, enabled: calendar.enabled, writable: calendar.is_writable };
}

async function loadOwnedConnection(database: SupabaseClient, userId: string): Promise<StoredConnection | null> {
  const { data, error } = await database.from("google_connections")
    .select("id,user_id,household_id,person_id,display_email,connection_state,access_token_encrypted,refresh_token_encrypted,token_expires_at")
    .eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  if (!data) return null;
  const connection = data as StoredConnection;
  const [membership, person] = await Promise.all([
    database.from("household_members").select("household_id").eq("household_id", connection.household_id).eq("user_id", userId).maybeSingle(),
    database.from("people").select("id").eq("household_id", connection.household_id).eq("id", connection.person_id).maybeSingle(),
  ]);
  if (membership.error || person.error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
  if (!membership.data || !person.data) throw new HttpError(403, "calendar_not_allowed", "Google calendar settings are not available");
  return connection;
}

export function createOwnedConnectionLoader(database: SupabaseClient) {
  return (userId: string) => loadOwnedConnection(database, userId);
}

function databaseStore(database: SupabaseClient): CalendarStore {
  return {
    loadConnection: createOwnedConnectionLoader(database),
    async replaceSnapshot(connectionId, userId, calendars) {
      const { error } = await database.rpc("replace_google_calendar_snapshot", { p_connection_id: connectionId, p_user_id: userId, p_calendars: calendars });
      if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
    },
    async listCalendars(connectionId) {
      const { data, error } = await database.from("google_calendars").select("id,google_calendar_id,display_name,time_zone,enabled,is_writable")
        .eq("google_connection_id", connectionId).order("display_name");
      if (error) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
      return (data ?? []) as StoredCalendar[];
    },
    async applySelection(connectionId, userId, personId, calendars) {
      const { data, error } = await database.rpc("set_google_calendar_selection", { p_connection_id: connectionId, p_user_id: userId, p_person_id: personId, p_calendars: calendars });
      if (error || !Array.isArray(data) || data.length !== 1) throw new HttpError(400, "calendar_not_available", "Google calendar settings could not be updated");
      return data[0] as StoredConnection;
    },
    async markReconnect(connectionId, userId) {
      const { data, error } = await database.rpc("mark_google_connection_reconnect_required", { p_connection_id: connectionId, p_user_id: userId });
      if (error || !Array.isArray(data) || data.length !== 1) throw new HttpError(503, "calendar_unavailable", "Google calendar settings are unavailable");
      return data[0] as StoredConnection;
    },
  };
}

async function fetchGoogleCalendarPage(connection: GoogleConnection, pageUrl: string): Promise<GoogleCalendarPage> {
  const response = await googleFetch(connection, pageUrl);
  try { return await response.json() as GoogleCalendarPage; }
  catch { throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid"); }
}
async function fetchFullSnapshot(connection: GoogleConnection, fetchPage: GoogleCalendarsDependencies["fetchCalendarPage"]): Promise<StoredCalendarRow[]> {
  const calendars: StoredCalendarRow[] = [];
  let pageToken: string | null = null;
  do {
    const pageUrl = new URL(CALENDAR_LIST_URL);
    if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
    const page = await (fetchPage ?? fetchGoogleCalendarPage)(connection, pageUrl.toString());
    if (!Array.isArray(page?.items)) throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid");
    calendars.push(...page.items.map((item) => calendarToStoredRow(item as GoogleCalendarListItem)));
    if (page.nextPageToken === undefined) pageToken = null;
    else if (typeof page.nextPageToken === "string" && page.nextPageToken.length > 0 && page.nextPageToken.length <= 2048) pageToken = page.nextPageToken;
    else throw new HttpError(502, "calendar_list_invalid", "Google calendar list was invalid");
  } while (pageToken);
  return calendars;
}

async function readUpdate(req: Request): Promise<{ personId: string; calendars: CalendarUpdate[] }> {
  let body: unknown;
  try { body = await req.json(); } catch { throw new HttpError(400, "invalid_request", "A JSON request body is required"); }
  const input = body as { personId?: unknown; calendars?: unknown };
  if (!isUuid(input?.personId) || !Array.isArray(input?.calendars)) throw new HttpError(400, "invalid_request", "A person and calendar selections are required");
  const calendars = input.calendars.map((value) => ({ googleCalendarId: (value as CalendarUpdate)?.googleCalendarId, enabled: (value as CalendarUpdate)?.enabled }));
  if (calendars.some((calendar) => typeof calendar.googleCalendarId !== "string" || !calendar.googleCalendarId || typeof calendar.enabled !== "boolean") ||
    new Set(calendars.map((calendar) => calendar.googleCalendarId)).size !== calendars.length) throw new HttpError(400, "invalid_request", "Calendar selections are invalid");
  return { personId: input.personId, calendars: calendars as CalendarUpdate[] };
}
async function responseBody(store: CalendarStore, connection: StoredConnection | null) {
  if (!connection) return { connection: null, calendars: [] };
  const calendars = await store.listCalendars(connection.id);
  return { connection: sanitizeConnection(connection), calendars: calendars.map(sanitizeCalendar) };
}

export function createGoogleCalendarsHandler(dependencies: GoogleCalendarsDependencies = {}) {
  return async function handleGoogleCalendars(req: Request): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;
    let headers = new Headers({ Vary: "Origin" });
    try {
      headers = corsHeaders(req);
      if (req.method !== "GET" && req.method !== "PUT") throw new HttpError(405, "method_not_allowed", "GET or PUT is required");
      const { userId } = await (dependencies.authenticate ?? requireUser)(req);
      const store = dependencies.store ?? databaseStore(dependencies.database ?? createServiceClient());
      const connection = await store.loadConnection(userId);
      if (req.method === "PUT") {
        if (!connection) throw new HttpError(404, "connection_not_found", "Google connection was not found");
        const selection = await readUpdate(req);
        const knownCalendarIds = new Set((await store.listCalendars(connection.id)).map((calendar) => calendar.google_calendar_id));
        if (selection.calendars.some((calendar) => !knownCalendarIds.has(calendar.googleCalendarId))) {
          throw new HttpError(400, "calendar_not_available", "A selected calendar is not available");
        }
        return json(200, await responseBody(store, await store.applySelection(connection.id, userId, selection.personId, selection.calendars)), headers);
      }
      if (!connection || connection.connection_state !== "active") return json(200, await responseBody(store, connection), headers);
      try {
        await store.replaceSnapshot(connection.id, userId, await fetchFullSnapshot(connection, dependencies.fetchCalendarPage));
      } catch (error) {
        if (error instanceof GoogleApiError && error.category === "authorization") return json(200, await responseBody(store, await store.markReconnect(connection.id, userId)), headers);
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, "calendar_list_failed", "Google calendars could not be loaded");
      }
      return json(200, await responseBody(store, connection), headers);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.code }, headers);
      return json(500, { error: "internal_error" }, headers);
    }
  };
}

export const handleGoogleCalendars = createGoogleCalendarsHandler();
if (typeof Deno !== "undefined") Deno.serve(handleGoogleCalendars);
