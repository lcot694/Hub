import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("npm:")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function createClient(){throw new Error('Unexpected database access')}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const calendarApi = import("../supabase/functions/google-calendars/index.ts");

test("Google calendar discovery stores the remote identity and edit permission", async () => {
  const { calendarToStoredRow } = await calendarApi;

  assert.deepEqual(calendarToStoredRow({
    id: "family@group.calendar.google.com",
    summary: "Family",
    timeZone: "America/Toronto",
    accessRole: "writer",
  }), {
    google_calendar_id: "family@group.calendar.google.com",
    display_name: "Family",
    time_zone: "America/Toronto",
    google_access_role: "writer",
    writable: true,
  });

  assert.equal(calendarToStoredRow({
    id: "holidays", summary: "Holidays", accessRole: "reader",
  }).writable, false);
});

test("calendar discovery exposes only a sanitized connection and calendar", async () => {
  const { sanitizeCalendar, sanitizeConnection } = await calendarApi;
  const connection = sanitizeConnection({
    id: "connection-1",
    household_id: "household-1",
    person_id: "person-1",
    display_email: "parent@example.test",
    connection_state: "active",
    access_token_encrypted: "secret",
    refresh_token_encrypted: "also-secret",
    last_error: "private detail",
  });
  const calendar = sanitizeCalendar({
    id: "row-1",
    google_calendar_id: "family",
    display_name: "Family",
    time_zone: "America/Toronto",
    enabled: true,
    is_writable: true,
    sync_token: "private-sync-token",
  });

  assert.deepEqual(connection, {
    id: "connection-1",
    householdId: "household-1",
    personId: "person-1",
    displayEmail: "parent@example.test",
    state: "active",
  });
  assert.deepEqual(calendar, {
    id: "row-1",
    googleCalendarId: "family",
    summary: "Family",
    timeZone: "America/Toronto",
    enabled: true,
    writable: true,
  });
  assert.doesNotMatch(JSON.stringify({ connection, calendar }), /secret|token|private detail/i);
});
