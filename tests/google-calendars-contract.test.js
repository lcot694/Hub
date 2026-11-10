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
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION = {
  id: "connection-1", user_id: USER_ID, household_id: "household-1", person_id: "person-1",
  display_email: "adult@example.test", connection_state: "active",
  access_token_encrypted: "encrypted-access", refresh_token_encrypted: "encrypted-refresh", token_expires_at: null,
  google_account_id: "google-account-1", oauth_generation: 1,
};

function store(overrides = {}) {
  const calls = [];
  return {
    calls,
    loadConnection: async (userId) => { calls.push(["load", userId]); return CONNECTION; },
    replaceSnapshot: async (...args) => { calls.push(["snapshot", ...args]); },
    listCalendars: async () => [{ id: "row-1", google_calendar_id: "family", display_name: "Family", time_zone: "America/Toronto", enabled: true, is_writable: true }],
    applySelection: async (...args) => { calls.push(["selection", ...args]); return { ...CONNECTION, person_id: args[2] }; },
    markReconnect: async (...args) => { calls.push(["reconnect", ...args]); return { ...CONNECTION, connection_state: "reconnect_required" }; },
    ...overrides,
  };
}

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

test("calendar handler follows every page before atomically replacing a snapshot", async () => {
  const { createGoogleCalendarsHandler } = await calendarApi;
  const database = store();
  const requested = [];
  const handler = createGoogleCalendarsHandler({
    authenticate: async () => ({ userId: USER_ID }), store: database,
    fetchCalendarPage: async (_connection, pageUrl) => {
      requested.push(pageUrl);
      return requested.length === 1
        ? { items: [{ id: "one", summary: "One", accessRole: "owner" }], nextPageToken: "page-2" }
        : { items: [{ id: "two", summary: "Two", accessRole: "reader" }] };
    },
  });

  const response = await handler(new Request("https://project.test/google-calendars", { method: "GET" }));
  assert.equal(response.status, 200);
  assert.equal(requested.length, 2);
  assert.match(requested[1], /pageToken=page-2/);
  const snapshots = database.calls.filter(([name]) => name === "snapshot");
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0][3], [
    { google_calendar_id: "one", display_name: "One", time_zone: null, google_access_role: "owner", writable: true },
    { google_calendar_id: "two", display_name: "Two", time_zone: null, google_access_role: "reader", writable: false },
  ]);
});

test("calendar handler does not persist a partial snapshot", async () => {
  const { createGoogleCalendarsHandler } = await calendarApi;
  const database = store();
  let page = 0;
  const handler = createGoogleCalendarsHandler({
    authenticate: async () => ({ userId: USER_ID }), store: database,
    fetchCalendarPage: async () => {
      page += 1;
      if (page === 1) return { items: [{ id: "one", summary: "One", accessRole: "owner" }], nextPageToken: "page-2" };
      throw new Error("Google failed");
    },
  });

  const response = await handler(new Request("https://project.test/google-calendars", { method: "GET" }));
  assert.equal(response.status, 502);
  assert.deepEqual(database.calls.filter(([name]) => name === "snapshot"), []);
  assert.deepEqual(await response.json(), { error: "calendar_list_failed" });
});

test("authorization failure marks the owned connection reconnect-required", async () => {
  const { GoogleApiError } = await import("../supabase/functions/_shared/google-client.ts");
  const { createGoogleCalendarsHandler } = await calendarApi;
  const database = store();
  const handler = createGoogleCalendarsHandler({
    authenticate: async () => ({ userId: USER_ID }), store: database,
    fetchCalendarPage: async () => { throw new GoogleApiError("authorization", 401); },
  });

  const response = await handler(new Request("https://project.test/google-calendars", { method: "GET" }));
  assert.equal(response.status, 200);
  assert.deepEqual(database.calls.filter(([name]) => name === "reconnect")[0].slice(1), [CONNECTION.id, USER_ID]);
  assert.equal((await response.json()).connection.state, "reconnect_required");
});

test("selection submits one all-or-nothing store operation", async () => {
  const { createGoogleCalendarsHandler } = await calendarApi;
  const database = store({ listCalendars: async () => [
    { google_calendar_id: "one" }, { google_calendar_id: "two" },
  ] });
  const handler = createGoogleCalendarsHandler({ authenticate: async () => ({ userId: USER_ID }), store: database });
  const response = await handler(new Request("https://project.test/google-calendars", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personId: USER_ID, calendars: [{ googleCalendarId: "one", enabled: true }, { googleCalendarId: "two", enabled: false }] }),
  }));
  assert.equal(response.status, 200);
  const selections = database.calls.filter(([name]) => name === "selection");
  assert.equal(selections.length, 1);
  assert.deepEqual(selections[0].slice(1), [CONNECTION.id, USER_ID, USER_ID, [
    { googleCalendarId: "one", enabled: true }, { googleCalendarId: "two", enabled: false },
  ]]);
});

test("calendar handler sanitizes method and authentication failures with allowed-origin CORS", async () => {
  const { HttpError } = await import("../supabase/functions/_shared/http.ts");
  const { createGoogleCalendarsHandler } = await calendarApi;
  const previous = globalThis.Deno;
  globalThis.Deno = { env: { get: (name) => name === "APP_ORIGIN" ? "https://family.example" : undefined } };
  try {
    const methodResponse = await createGoogleCalendarsHandler()(
      new Request("https://project.test/google-calendars", { method: "POST", headers: { Origin: "https://family.example" } }),
    );
    const authResponse = await createGoogleCalendarsHandler({
      authenticate: async () => { throw new HttpError(401, "unauthorized", "details stay private"); }, store: store(),
    })(new Request("https://project.test/google-calendars", { method: "GET", headers: { Origin: "https://family.example" } }));
    assert.deepEqual(await methodResponse.json(), { error: "method_not_allowed" });
    assert.deepEqual(await authResponse.json(), { error: "unauthorized" });
    assert.equal(authResponse.headers.get("Access-Control-Allow-Origin"), "https://family.example");
  } finally {
    if (previous === undefined) delete globalThis.Deno;
    else globalThis.Deno = previous;
  }
});

test("owned connection loader validates owned, absent, membership, and household-scoped records with a Supabase query client", async () => {
  const { createOwnedConnectionLoader } = await calendarApi;
  for (const scenario of [
    { name: "owned connection", connection: CONNECTION, member: true, person: true, result: CONNECTION },
    { name: "wrong user has no row", connection: null, member: true, person: true, result: null },
    { name: "not a member", connection: CONNECTION, member: false, person: true, status: 403 },
    { name: "person in another household", connection: CONNECTION, member: true, person: false, status: 403 },
  ]) {
    let connectionColumns = "";
    const database = { from(table) {
      const result = table === "google_connections" ? scenario.connection : table === "household_members" ? scenario.member ? {} : null : scenario.person ? {} : null;
      return { select(columns) { if (table === "google_connections") connectionColumns = columns; return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: result, error: null }); } };
    } };
    if (scenario.status === undefined) assert.equal(await createOwnedConnectionLoader(database)(USER_ID), scenario.result);
    else await assert.rejects(createOwnedConnectionLoader(database)(USER_ID), (error) => error.status === scenario.status);
    assert.match(connectionColumns, /google_account_id/);
    assert.match(connectionColumns, /oauth_generation/);
  }
});

test("handler skips disconnected connections and rejects unknown selections before the transaction", async () => {
  const { createGoogleCalendarsHandler } = await calendarApi;
  const disconnected = store({ loadConnection: async () => ({ ...CONNECTION, connection_state: "disconnected" }) });
  let fetched = false;
  const get = await createGoogleCalendarsHandler({ authenticate: async () => ({ userId: USER_ID }), store: disconnected, fetchCalendarPage: async () => { fetched = true; return { items: [] }; } })(new Request("https://project.test/google-calendars"));
  assert.equal(get.status, 200);
  assert.equal(fetched, false);
  assert.equal((await get.json()).connection.state, "disconnected");

  const selected = store();
  const put = await createGoogleCalendarsHandler({ authenticate: async () => ({ userId: USER_ID }), store: selected })(new Request("https://project.test/google-calendars", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personId: USER_ID, calendars: [{ googleCalendarId: "missing", enabled: true }] }) }));
  assert.equal(put.status, 400);
  assert.equal(selected.calls.some(([name]) => name === "selection"), false);
});

test("handler answers allowed OPTIONS and rejects a foreign origin", async () => {
  const { createGoogleCalendarsHandler } = await calendarApi;
  const previous = globalThis.Deno;
  globalThis.Deno = { env: { get: (name) => name === "APP_ORIGIN" ? "https://family.example" : undefined } };
  try {
    const options = await createGoogleCalendarsHandler()(new Request("https://project.test/google-calendars", { method: "OPTIONS", headers: { Origin: "https://family.example" } }));
    const foreign = await createGoogleCalendarsHandler()(new Request("https://project.test/google-calendars", { method: "GET", headers: { Origin: "https://evil.example" } }));
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("Access-Control-Allow-Origin"), "https://family.example");
    assert.deepEqual(await foreign.json(), { error: "origin_not_allowed" });
  } finally { if (previous === undefined) delete globalThis.Deno; else globalThis.Deno = previous; }
});
