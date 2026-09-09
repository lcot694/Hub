# Google Calendar Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, reliable two-way Google Calendar synchronization while preserving every existing Family Hub flow.

**Architecture:** Family Hub remains local-first in Supabase. Browser writes commit locally and database RPCs enqueue Google operations; Supabase Edge Functions own OAuth, encrypted credentials, incremental Google pulls, queued pushes, reconciliation, and retries. Pure calendar, queue, and conflict logic lives in small dependency-free modules tested with Node's built-in test runner.

**Tech Stack:** Static HTML/CSS/ES modules, Supabase Auth/Postgres/RLS/Realtime/Edge Functions, Google Calendar API v3 and OAuth 2.0, JavaScript/TypeScript, Node `node:test`, Deno runtime for Edge Functions.

**Spec:** `docs/superpowers/specs/2026-08-26-google-calendar-sync-design.md`

## Global Constraints

- Existing authentication, household joining, people management, day/week/month views, event editing/deletion, realtime refresh, and PWA behavior must remain functional.
- Each adult connects only their own Google account and selects an existing Family Hub person.
- Google tokens, client secrets, encryption keys, and service-role credentials never enter browser code, browser-readable tables, logs, or commits.
- Family Hub person assignment and colour never modify Google.
- Synchronize title, date, start/end time, all-day status, supported recurrence, and deletion.
- Support simple daily, weekly, monthly, and yearly series; complex recurrence exceptions remain read-only.
- Household time zone defaults to `America/Toronto`; all-day events remain date-only.
- Most-recent-change wins using server timestamps; Google wins exact ties.
- Read-only Google calendars never offer Google-owned field editing or deletion.
- Delete-everywhere requires explicit confirmation and remains recoverable until Google confirms.
- Existing `schema.sql` and `supabase-setup.sql` are historical setup references; apply new behavior through versioned additive migrations.
- Google API tests use mocked HTTP responses and non-production secrets.

## File Structure

- `package.json` — zero-dependency test commands using Node's built-in runner.
- `lib/calendar-domain.js` — browser-safe date, recurrence, and display helpers.
- `lib/google-event-model.js` — pure Google/Family Hub event translation.
- `lib/sync-policy.js` — pure conflict, retry, queue supersession, and status rules.
- `lib/google-ui.js` — Google settings, calendar destination, and sync-status UI controller.
- `tests/*.test.js` — unit and characterization tests for pure modules and browser-adjacent contracts.
- `supabase/migrations/202608260001_google_sync_schema.sql` — schema, constraints, RLS, grants, queue RPCs, and event triggers.
- `supabase/migrations/202608260002_google_sync_schedule.sql` — cron/HTTP scheduling contract and secure invocation wrapper.
- `supabase/functions/_shared/*.ts` — authentication, encryption, database, HTTP, and Google client adapters.
- `supabase/functions/_shared/*.js` — runtime-neutral calendar and sync logic mirrored from or re-exporting tested `lib` contracts.
- `supabase/functions/google-oauth-start/index.ts` — authenticated OAuth initiation.
- `supabase/functions/google-oauth-callback/index.ts` — OAuth callback, token exchange, and secure storage.
- `supabase/functions/google-calendars/index.ts` — list and update enabled calendars/person association.
- `supabase/functions/google-sync/index.ts` — authorized app-open/manual orchestration.
- `supabase/functions/google-sync-scheduled/index.ts` — cron-authorized batch orchestration.
- `supabase/functions/google-disconnect/index.ts` — disconnect and local-copy policy.
- `app.js` — existing app orchestration integrated with the new focused modules.
- `index.html` — Google settings, event destination, status, and confirmation controls.
- `styles.css` — states and settings layout.
- `sw.js` — cache-name bump and complete asset list.
- `README.txt` — deployment secrets, Google Cloud, Supabase migration/function, and scheduler instructions.

---

### Task 1: Establish Tests and Characterize Existing Calendar Behavior

**Files:**
- Create: `package.json`
- Create: `lib/calendar-domain.js`
- Create: `tests/calendar-domain.test.js`
- Modify: `app.js:20-50`

**Interfaces:**
- Produces: `toISO(date): string`, `parseISO(value): Date`, `occursOn(event, date): boolean`, `eventsFor(events, date): object[]`.
- Consumes: Existing event fields `event_date`, `start_time`, `recurrence`, and `recurrence_end`.

- [ ] **Step 1: Add a zero-dependency test command and failing characterization tests**

```json
{
  "name": "family-hub",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test tests/*.test.js"
  }
}
```

```js
// tests/calendar-domain.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { occursOn, eventsFor } from "../lib/calendar-domain.js";

test("weekly events occur every seven days through recurrence_end", () => {
  const event = { event_date:"2026-08-03", start_time:"09:00", recurrence:"weekly", recurrence_end:"2026-08-31" };
  assert.equal(occursOn(event, new Date(2026, 7, 10)), true);
  assert.equal(occursOn(event, new Date(2026, 7, 11)), false);
  assert.equal(occursOn(event, new Date(2026, 8, 7)), false);
});

test("eventsFor preserves start-time ordering", () => {
  const events = [
    { id:"late", event_date:"2026-08-26", start_time:"17:00", recurrence:"none" },
    { id:"early", event_date:"2026-08-26", start_time:"08:00", recurrence:"none" }
  ];
  assert.deepEqual(eventsFor(events, new Date(2026, 7, 26)).map(x => x.id), ["early", "late"]);
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `npm test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/calendar-domain.js`.

- [ ] **Step 3: Extract the current behavior without changing it**

```js
// lib/calendar-domain.js
export function toISO(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toLocaleDateString("en-CA");
}

export function parseISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function occursOn(event, date) {
  const target = toISO(date);
  if (event.recurrence === "none") return event.event_date === target;
  if (target < event.event_date || (event.recurrence_end && target > event.recurrence_end)) return false;
  const diff = Math.round((date - parseISO(event.event_date)) / 86400000);
  if (event.recurrence === "daily") return diff >= 0;
  if (event.recurrence === "weekly") return diff >= 0 && diff % 7 === 0;
  return false;
}

export function eventsFor(events, date) {
  return events.filter(event => occursOn(event, date))
    .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
}
```

Import these functions in `app.js` and delete only their duplicate local definitions.

- [ ] **Step 4: Verify characterized behavior and browser syntax**

Run: `npm test`

Expected: 2 tests pass.

Run: `node --check app.js && node --check lib/calendar-domain.js`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the characterized baseline**

```bash
git add package.json lib/calendar-domain.js tests/calendar-domain.test.js app.js
git commit -m "test: characterize calendar domain behavior"
```

### Task 2: Extend Calendar Domain for All-Day and Monthly/Yearly Recurrence

**Files:**
- Modify: `lib/calendar-domain.js`
- Modify: `tests/calendar-domain.test.js`

**Interfaces:**
- Consumes: Task 1 calendar helpers.
- Produces: `occursOn` support for `monthly` and `yearly`; `normalizeEventTimes(input): { all_day, start_time, end_time }`.

- [ ] **Step 1: Add failing recurrence and all-day tests**

```js
test("monthly recurrence clamps to the final day of shorter months", () => {
  const event = { event_date:"2026-01-31", recurrence:"monthly", recurrence_end:null };
  assert.equal(occursOn(event, new Date(2026, 1, 28)), true);
  assert.equal(occursOn(event, new Date(2026, 2, 31)), true);
});

test("yearly recurrence preserves February 29 semantics", () => {
  const event = { event_date:"2024-02-29", recurrence:"yearly", recurrence_end:null };
  assert.equal(occursOn(event, new Date(2025, 1, 28)), true);
  assert.equal(occursOn(event, new Date(2028, 1, 29)), true);
});

test("all-day normalization removes clock values", () => {
  assert.deepEqual(normalizeEventTimes({ all_day:true, start_time:"09:00", end_time:"10:00" }), {
    all_day:true, start_time:null, end_time:null
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test tests/calendar-domain.test.js`

Expected: FAIL for monthly/yearly matching and missing `normalizeEventTimes` export.

- [ ] **Step 3: Implement minimal calendar rules**

Add `daysInMonth`, monthly anniversary, and yearly anniversary helpers. Define leap-day behavior as the last day of February in non-leap years. Export:

```js
export function normalizeEventTimes(input) {
  return input.all_day
    ? { all_day:true, start_time:null, end_time:null }
    : { all_day:false, start_time:input.start_time || null, end_time:input.end_time || null };
}
```

Extend `occursOn` to compare target dates with calculated monthly/yearly anniversaries without converting date-only values through UTC.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar-domain.js tests/calendar-domain.test.js
git commit -m "feat: support extended recurrence and all-day events"
```

### Task 3: Add the Additive Google Sync Database Schema

**Files:**
- Create: `supabase/migrations/202608260001_google_sync_schema.sql`
- Create: `tests/google-sync-schema.test.js`

**Interfaces:**
- Produces tables: `google_connections`, `google_calendars`, `google_event_mappings`, `google_sync_queue`, `google_oauth_flows`.
- Produces RPCs: `enqueue_google_event_change(uuid,text)`, `claim_google_sync_jobs(integer,integer)`, `complete_google_sync_job(uuid)`, `fail_google_sync_job(uuid,text,text,timestamptz)`.
- Extends: `households.time_zone`; `events.all_day`, recurrence check, `updated_at`, `sync_deleted_at`.

- [ ] **Step 1: Write a failing migration contract test**

```js
// tests/google-sync-schema.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sqlPath = new URL("../supabase/migrations/202608260001_google_sync_schema.sql", import.meta.url);

test("migration contains required private tables, constraints, and RPCs", async () => {
  const sql = await readFile(sqlPath, "utf8");
  for (const token of [
    "create table public.google_connections",
    "create table public.google_calendars",
    "create table public.google_event_mappings",
    "create table public.google_sync_queue",
    "create table public.google_oauth_flows",
    "claim_google_sync_jobs",
    "unique (google_connection_id, google_calendar_id, google_event_id)"
  ]) assert.match(sql.toLowerCase(), new RegExp(token.replace(/[()]/g, "\\$&")));
  assert.match(sql, /check \(recurrence in \('none','daily','weekly','monthly','yearly'\)\)/i);
  assert.match(sql, /America\/Toronto/);
});
```

- [ ] **Step 2: Run the schema contract test**

Run: `node --test tests/google-sync-schema.test.js`

Expected: FAIL because the migration file does not exist.

- [ ] **Step 3: Write the migration with explicit security boundaries**

The migration must:

- Add `households.time_zone text not null default 'America/Toronto'`.
- Add `events.all_day boolean not null default false`, `events.updated_at timestamptz not null default now()`, and `events.sync_deleted_at timestamptz`.
- Replace the recurrence check with exactly `none`, `daily`, `weekly`, `monthly`, and `yearly`.
- Add an `events_set_updated_at` trigger using database time.
- Store encrypted credential bytes only in `google_connections`; revoke all direct browser roles from credential and OAuth-flow tables.
- Allow authenticated adults to select sanitized connection/calendar/mapping/status fields through security-definer RPCs or a safe view that excludes token columns.
- Enable RLS on every new table.
- Restrict calendar selection updates to `user_id = auth.uid()` and verified household membership.
- Add queue uniqueness preventing multiple actionable jobs for the same mapped event.
- Use `FOR UPDATE SKIP LOCKED` in `claim_google_sync_jobs` and assign a bounded processing lease.
- Make queue completion/failure RPCs callable only by `service_role`.
- Add indexes for due jobs, connection ownership, calendar connection, and mapped Family Hub events.

Use a trigger to enqueue `create` or `update` only when a mapped event's Google-owned fields change. Do not enqueue when only `person_id` changes. Pending deletes are initiated through the explicit RPC rather than a hard browser delete.

- [ ] **Step 4: Verify schema contracts and SQL formatting**

Run: `npm test`

Expected: all tests pass.

Run when a local Supabase CLI is available: `supabase db reset`

Expected: migrations apply without errors and existing schema smoke checks pass. If the CLI is unavailable, record that integration verification as an environment prerequisite rather than claiming it ran.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202608260001_google_sync_schema.sql tests/google-sync-schema.test.js
git commit -m "feat: add Google synchronization schema"
```

### Task 4: Implement Pure Google Event Translation and Conflict Policy

**Files:**
- Create: `lib/google-event-model.js`
- Create: `lib/sync-policy.js`
- Create: `tests/google-event-model.test.js`
- Create: `tests/sync-policy.test.js`
- Create: `supabase/functions/_shared/google-event-model.js`
- Create: `supabase/functions/_shared/sync-policy.js`

**Interfaces:**
- Produces: `googleToFamilyEvent(googleEvent, context): TranslationResult`.
- Produces: `familyToGoogleEvent(familyEvent, context): object`.
- Produces: `chooseConflictWinner(mapping, familyEvent, googleEvent): "family"|"google"|"unchanged"`.
- Produces: `retryDecision(errorCategory, attempt, now): { retryable:boolean, nextAttemptAt:string|null }`.

- [ ] **Step 1: Write failing translation tests**

```js
test("all-day Google dates remain date-only", () => {
  const result = googleToFamilyEvent(
    { id:"g1", summary:"School", start:{date:"2026-09-01"}, end:{date:"2026-09-02"}, updated:"2026-08-26T12:00:00Z" },
    { householdId:"h1", defaultPersonId:"p1", householdTimeZone:"America/Toronto" }
  );
  assert.equal(result.supported, true);
  assert.equal(result.event.event_date, "2026-09-01");
  assert.equal(result.event.all_day, true);
  assert.equal(result.event.start_time, null);
});

test("Family Hub metadata is absent from Google payloads", () => {
  const payload = familyToGoogleEvent({
    title:"Practice", event_date:"2026-09-02", start_time:"18:00", end_time:"19:00",
    all_day:false, recurrence:"weekly", recurrence_end:"2026-12-01", person_id:"child", color:"#fff"
  }, { householdTimeZone:"America/Toronto" });
  assert.equal(payload.summary, "Practice");
  assert.equal("person_id" in payload, false);
  assert.equal("color" in payload, false);
  assert.deepEqual(payload.recurrence, ["RRULE:FREQ=WEEKLY;UNTIL=20261202T045959Z"]);
});

test("complex recurrence exceptions are read-only", () => {
  const result = googleToFamilyEvent({ id:"g2", recurringEventId:"series", originalStartTime:{dateTime:"2026-09-03T18:00:00-04:00"} }, context);
  assert.equal(result.supported, false);
  assert.equal(result.readOnlyReason, "complex_recurrence_exception");
});
```

- [ ] **Step 2: Write failing conflict and retry tests**

```js
test("Google wins an exact conflict timestamp tie", () => {
  const time = "2026-08-26T12:00:00.000Z";
  assert.equal(chooseConflictWinner(
    { last_family_updated_at:"2026-08-25T00:00:00Z", last_google_updated_at:"2026-08-25T00:00:00Z" },
    { updated_at:time }, { updated:time }
  ), "google");
});

test("authorization errors require reconnect without retry", () => {
  assert.deepEqual(retryDecision("authorization", 2, "2026-08-26T12:00:00Z"), {
    retryable:false, nextAttemptAt:null
  });
});
```

- [ ] **Step 3: Run focused tests and confirm missing exports**

Run: `node --test tests/google-event-model.test.js tests/sync-policy.test.js`

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement pure translators and policies**

Use `Intl.DateTimeFormat` with the household IANA zone for timed values and direct string handling for `date` values. Support only RRULEs whose meaningful fields are `FREQ`, `INTERVAL=1`, and optional `UNTIL` for `DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`. Return `{ supported:false, readOnlyReason }` for exceptions, `BYSETPOS`, multiple rules, or overridden instances.

Conflict comparison must first detect whether each side changed since the mapping's last observed timestamps. Return `unchanged` if neither changed, the sole changed side if one changed, and compare authoritative timestamps if both changed. Return `google` for exact ties.

Retry categories are `transient`, `rate_limit`, `authorization`, `permission`, `validation`, and `permanent`. Transient/rate-limit delays use `min(3600, 2 ** attempt * 30)` seconds plus deterministic injectable jitter in tests.

Keep the Edge Function copies byte-identical to the tested modules or make them thin re-exports so the runtime uses the tested policy.

- [ ] **Step 5: Run all tests and commit**

Run: `npm test`

Expected: all tests pass.

```bash
git add lib/google-event-model.js lib/sync-policy.js tests/google-event-model.test.js tests/sync-policy.test.js supabase/functions/_shared/google-event-model.js supabase/functions/_shared/sync-policy.js
git commit -m "feat: add Google event translation and sync policy"
```

### Task 5: Build Secure Edge Function Foundations

**Files:**
- Create: `supabase/functions/_shared/auth.ts`
- Create: `supabase/functions/_shared/crypto.ts`
- Create: `supabase/functions/_shared/db.ts`
- Create: `supabase/functions/_shared/http.ts`
- Create: `supabase/functions/_shared/google-client.ts`
- Create: `tests/edge-contracts.test.js`

**Interfaces:**
- Produces: `requireUser(req): Promise<UserContext>`.
- Produces: `encryptToken(plainText, key): Promise<string>` and `decryptToken(cipherText, key): Promise<string>` using AES-GCM.
- Produces: `googleFetch(connection, request): Promise<Response>` with one refresh-and-retry on token expiry.
- Produces: `json(status, body)` and an allowlisted CORS handler.

- [ ] **Step 1: Write failing source-contract tests**

Assert that shared source files exist, reference `crypto.subtle` with `AES-GCM`, require `SUPABASE_SERVICE_ROLE_KEY` only in server code, omit tokens from thrown messages, validate `Origin` against `APP_ORIGIN`, and classify Google 401, 403, 404, 409, 429, and 5xx responses.

```js
test("browser source never contains server secret names", async () => {
  for (const path of ["app.js", "config.js", "lib/google-ui.js"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8").catch(() => "");
    assert.doesNotMatch(source, /GOOGLE_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY|TOKEN_ENCRYPTION_KEY/);
  }
});
```

- [ ] **Step 2: Run the contract tests and confirm failure**

Run: `node --test tests/edge-contracts.test.js`

Expected: FAIL because shared Edge Function files are absent.

- [ ] **Step 3: Implement authentication, encryption, and HTTP adapters**

`requireUser` must validate the bearer JWT with Supabase Auth, return `{ userId, accessToken }`, and never trust a user ID from request JSON. `crypto.ts` must validate a 32-byte base64 deployment key, generate a fresh 12-byte IV, and encode `version || IV || ciphertext` as base64. `google-client.ts` must inject `fetch` for tests, refresh an expired access token once, encrypt updated token material before persistence, and return categorized errors without response bodies containing tokens.

Required server secrets:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI
GOOGLE_TOKEN_ENCRYPTION_KEY
APP_ORIGIN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SYNC_CRON_SECRET
```

- [ ] **Step 4: Run tests and type-check Edge Functions**

Run: `npm test`

Expected: all tests pass.

Run when Deno is available: `Get-ChildItem supabase/functions/_shared/*.ts | ForEach-Object { deno check $_.FullName }`

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared tests/edge-contracts.test.js
git commit -m "feat: add secure Edge Function foundations"
```

### Task 6: Implement OAuth Start and Callback

**Files:**
- Create: `supabase/functions/google-oauth-start/index.ts`
- Create: `supabase/functions/google-oauth-callback/index.ts`
- Create: `tests/oauth-contracts.test.js`

**Interfaces:**
- Consumes: `requireUser`, `encryptToken`, `json`, service-role database client.
- Produces: authenticated `POST /google-oauth-start` returning `{ authorizationUrl }`.
- Produces: public Google redirect `GET /google-oauth-callback?code&state` returning an allowlisted app redirect.

- [ ] **Step 1: Write failing OAuth contract tests**

Verify source contracts for PKCE S256, a cryptographically random state value, a short-lived `google_oauth_flows` row tied to authenticated user/household/person, one-time state consumption, exact redirect URI, offline access, consent prompting, and scopes:

```text
openid
email
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
```

Verify callback redirects use only `${APP_ORIGIN}/?google=connected` or `${APP_ORIGIN}/?google=error&code=<sanitized-code>`.

- [ ] **Step 2: Run OAuth contracts and confirm failure**

Run: `node --test tests/oauth-contracts.test.js`

Expected: FAIL because handlers are absent.

- [ ] **Step 3: Implement OAuth initiation and callback**

The start handler accepts `{ householdId, personId }`, verifies both household membership and that the person belongs to the household, stores only a hash of state plus the PKCE verifier and ten-minute expiry, then returns the Google authorization URL.

The callback hashes and atomically consumes `state`, rejects expired/used flows, exchanges the code, calls Google's userinfo endpoint for stable account ID/email, encrypts token material, and upserts a connection unique on `(user_id, google_account_id)`. It then redirects to the exact allowlisted app origin. Never put Supabase JWTs or Google tokens in URLs.

- [ ] **Step 4: Verify tests and Deno checks**

Run: `npm test`

Expected: all tests pass.

Run when available: `deno check supabase/functions/google-oauth-start/index.ts supabase/functions/google-oauth-callback/index.ts`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/google-oauth-start supabase/functions/google-oauth-callback tests/oauth-contracts.test.js
git commit -m "feat: add Google OAuth connection flow"
```

### Task 7: Implement Calendar Discovery and Selection

**Files:**
- Create: `supabase/functions/google-calendars/index.ts`
- Create: `tests/google-calendars-contract.test.js`
- Create: `lib/google-ui.js`
- Create: `tests/google-ui.test.js`
- Modify: `index.html:139-148`
- Modify: `styles.css`
- Modify: `app.js`

**Interfaces:**
- Produces API operations: `GET` sanitized connection/calendars and `PUT { personId, calendars:[{ googleCalendarId, enabled }] }`.
- Produces browser controller: `createGoogleSettings({ supabase, root, getContext, onChanged })`.

- [ ] **Step 1: Write failing calendar API and UI tests**

API contracts must verify that calendar discovery maps Google `accessRole` to `writable = accessRole === "owner" || accessRole === "writer"`, persists calendar ID/name/time zone/permission, and returns no token fields.

```js
test("read-only calendars cannot become event destinations", () => {
  const options = calendarDestinationOptions([
    { id:"family", summary:"Family", enabled:true, writable:true },
    { id:"holidays", summary:"Holidays", enabled:true, writable:false }
  ]);
  assert.deepEqual(options.map(x => x.value), ["family-hub-only", "family"]);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test tests/google-calendars-contract.test.js tests/google-ui.test.js`

Expected: FAIL for missing handlers/modules.

- [ ] **Step 3: Implement calendar discovery and settings UI**

Add a Google Calendar subsection inside `familyDialog` with IDs `googleSettings`, `googleConnectBtn`, `googlePerson`, `googleCalendarList`, `googleSyncNowBtn`, and `googleDisconnectBtn`. Render loading, disconnected, reconnect, and connected states. Use text nodes for remote calendar names and account email. Do not use remote strings in `innerHTML`.

On connection, pass the selected `personId` to OAuth start. After callback, load calendars. Calendar checkboxes call the `PUT` operation. Display **Can edit** or **Read only** based on the derived permission.

- [ ] **Step 4: Verify unit tests, syntax, and manual settings behavior**

Run: `npm test && node --check app.js && node --check lib/google-ui.js`

Expected: all checks pass.

Manual: open Family settings with no connection, with mocked connected calendars, and with reconnect state; confirm only writable enabled calendars appear as event destinations.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/google-calendars tests/google-calendars-contract.test.js lib/google-ui.js tests/google-ui.test.js index.html styles.css app.js
git commit -m "feat: add Google calendar connection settings"
```

### Task 8: Implement Transactional Queueing and Safe Deletion RPCs

**Files:**
- Modify: `supabase/migrations/202608260001_google_sync_schema.sql`
- Create: `tests/sync-queue-schema.test.js`

**Interfaces:**
- Produces: `save_google_backed_event(jsonb): uuid` and `request_google_event_delete(uuid): void` authenticated RPCs.
- Consumes: mapping and queue tables from Task 3.

- [ ] **Step 1: Add failing queue SQL contracts**

Tests must assert that `save_google_backed_event` validates household membership, connection ownership, enabled/writable calendar status, and writes event/mapping/queue in one transaction. `request_google_event_delete` must set `sync_deleted_at`, enqueue `delete`, and never hard-delete first.

Assert queue supersession rules:

- create + update becomes one create carrying current event data;
- update + update becomes one update;
- create + delete before Google creation removes the unsynchronized mapping and finalizes locally;
- update + delete becomes one delete;
- delete cannot be superseded by update.

- [ ] **Step 2: Run queue schema tests and confirm failure**

Run: `node --test tests/sync-queue-schema.test.js`

Expected: FAIL because RPC bodies are incomplete.

- [ ] **Step 3: Implement the RPCs and queue invariants**

Use `auth.uid()` inside authenticated RPCs, lock the event/mapping row before queue mutation, validate all IDs server-side, and return stable SQLSTATE codes translated by the UI. Ensure ordinary Family-Hub-only events still use the existing direct insert/update/delete path.

- [ ] **Step 4: Run all tests and database reset where available**

Run: `npm test`

Expected: all tests pass.

Run when available: `supabase db reset`

Expected: migration and RPC smoke tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202608260001_google_sync_schema.sql tests/sync-queue-schema.test.js
git commit -m "feat: queue Google event changes transactionally"
```

### Task 9: Implement Google Push Worker

**Files:**
- Create: `supabase/functions/_shared/push-worker.ts`
- Create: `tests/push-worker-contract.test.js`

**Interfaces:**
- Produces: `processPushJob(job, deps): Promise<PushResult>`.
- Consumes: claimed queue jobs, mapping records, `familyToGoogleEvent`, and injected Google/database adapters.

- [ ] **Step 1: Write failing push behavior contracts**

Cover create, update, delete, read-only rejection, 404-as-success for delete, refresh/retry on authorization expiry, ambiguous create replay, and mapping timestamp updates. Require stable Google event IDs for Family Hub-created events, derived from the Family Hub UUID without hyphens and prefixed with `fh`, so retrying a timed-out create cannot duplicate it.

```js
test("delete treats an already-absent Google event as success", async () => {
  const result = await processPushJob(deleteJob, fakeDeps({ googleStatus:404 }));
  assert.equal(result.status, "complete");
  assert.equal(result.finalizeLocalDelete, true);
});
```

- [ ] **Step 2: Run the push contract tests and confirm failure**

Run: `node --test tests/push-worker-contract.test.js`

Expected: FAIL because `push-worker.ts` is absent.

- [ ] **Step 3: Implement push processing**

For create, use `events.insert` with the stable ID and persist the mapping only after Google confirms. For update, use `If-Match` with the stored ETag; on `412`, fetch the current Google event and invoke conflict policy rather than overwriting. For delete, accept 204, 404, or `cancelled` as confirmation, then finalize local deletion transactionally.

Categorize errors, store only sanitized details, update reconnect state on authorization errors, and call `fail_google_sync_job` with the calculated next attempt for retryable errors.

- [ ] **Step 4: Run all tests and Deno checks**

Run: `npm test`

Expected: all tests pass.

Run when available: `deno check supabase/functions/_shared/push-worker.ts`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/push-worker.ts tests/push-worker-contract.test.js
git commit -m "feat: process queued Google event changes"
```

### Task 10: Implement Incremental Pull and Reconciliation

**Files:**
- Create: `supabase/functions/_shared/pull-worker.ts`
- Create: `tests/pull-worker-contract.test.js`

**Interfaces:**
- Produces: `pullCalendar(calendar, deps): Promise<PullResult>`.
- Consumes: Google calendar selection, mapping table, `googleToFamilyEvent`, and `chooseConflictWinner`.

- [ ] **Step 1: Write failing pull contracts**

Cover page traversal, next-sync-token commit only after all pages succeed, new import with default person, mapped update, duplicate replay, local-only metadata preservation, Google cancellation, exact conflict tie, expired sync token 410, and read-only complex recurrence.

```js
test("a failed second page does not advance the saved sync token", async () => {
  const deps = fakePullDeps({ pages:[successfulPageWithNextToken, transientFailure] });
  await assert.rejects(() => pullCalendar(calendar, deps));
  assert.equal(deps.savedSyncTokens.length, 0);
});
```

- [ ] **Step 2: Run the pull tests and confirm failure**

Run: `node --test tests/pull-worker-contract.test.js`

Expected: FAIL because `pull-worker.ts` is absent.

- [ ] **Step 3: Implement incremental synchronization**

Request `singleEvents=false`, `showDeleted=true`, and the saved `syncToken`. Process every page in a database transaction boundary appropriate for bounded batches, then persist only the final `nextSyncToken`. Upsert mappings by `(connection, calendar, google_event_id)`.

On Google 410, clear the invalid token and perform full reconciliation. Mark rows seen during that reconciliation; do not delete unseen local records until the complete scan succeeds. Preserve `person_id` and all other Family-Hub-only metadata on Google updates.

- [ ] **Step 4: Run all tests and Deno checks**

Run: `npm test`

Expected: all tests pass.

Run when available: `deno check supabase/functions/_shared/pull-worker.ts`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/pull-worker.ts tests/pull-worker-contract.test.js
git commit -m "feat: pull and reconcile Google calendar changes"
```

### Task 11: Add Manual, App-Open, and Scheduled Orchestration

**Files:**
- Create: `supabase/functions/google-sync/index.ts`
- Create: `supabase/functions/google-sync-scheduled/index.ts`
- Create: `supabase/migrations/202608260002_google_sync_schedule.sql`
- Create: `tests/sync-orchestration-contract.test.js`
- Modify: `lib/google-ui.js`
- Modify: `app.js`

**Interfaces:**
- Produces authenticated `POST /google-sync` with `{ reason:"manual"|"app_open" }`.
- Produces cron-authorized `POST /google-sync-scheduled`.
- Consumes: `pullCalendar`, `processPushJob`, and queue claim RPCs.

- [ ] **Step 1: Write failing orchestration contracts**

Verify manual sync is restricted to the caller's connection, app-open sync is server-throttled to one request per connection per five minutes, scheduled sync processes due connections in bounded batches, queue leases recover after expiry, and `SYNC_CRON_SECRET` is compared without logging it.

- [ ] **Step 2: Run orchestration tests and confirm failure**

Run: `node --test tests/sync-orchestration-contract.test.js`

Expected: FAIL because handlers and schedule migration are absent.

- [ ] **Step 3: Implement orchestrators and schedule wrapper**

The authenticated handler validates the session, records a sync request, and returns `202 { status:"syncing" }` quickly. The scheduled handler pulls enabled calendars and drains a bounded number of due queue jobs, leaving remaining work for the next run.

The schedule migration must use Supabase Vault for the cron secret and project URL reference rather than embedding secret text in SQL. Document the exact Vault secret names `project_url` and `google_sync_cron_secret`. Schedule every five minutes.

Call app-open sync after `loadHousehold()` completes and wire **Sync now** to manual sync. Realtime changes update visible state; do not poll continuously in the browser.

- [ ] **Step 4: Run tests and manual throttling check**

Run: `npm test && node --check app.js && node --check lib/google-ui.js`

Expected: all checks pass.

Manual: trigger app-open sync twice inside five minutes and confirm the second request returns a throttled/no-op result without duplicating work.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/google-sync supabase/functions/google-sync-scheduled supabase/migrations/202608260002_google_sync_schedule.sql tests/sync-orchestration-contract.test.js lib/google-ui.js app.js
git commit -m "feat: orchestrate scheduled and on-demand calendar sync"
```

### Task 12: Integrate Google Destinations, Statuses, and Safe Deletion in the Event UI

**Files:**
- Modify: `index.html:115-136`
- Modify: `styles.css`
- Modify: `app.js:120-370`
- Modify: `lib/google-ui.js`
- Create: `tests/event-sync-ui.test.js`

**Interfaces:**
- Consumes: writable calendar options, mapping status view/RPCs, `save_google_backed_event`, and `request_google_event_delete`.
- Produces: event destination selector and `renderEventSyncState(mapping)`.

- [ ] **Step 1: Write failing UI model tests**

```js
test("Google-backed delete copy names the external calendar", () => {
  assert.equal(deleteWarning({ title:"Dentist", calendarName:"Personal" }),
    "Delete \"Dentist\" from Family Hub and Google Calendar “Personal”? This deletes it everywhere.");
});

test("read-only mappings lock Google-owned fields but not person assignment", () => {
  assert.deepEqual(editPermissions({ writable:false }), {
    title:false, date:false, times:false, recurrence:false, person:true, deleteEverywhere:false
  });
});
```

- [ ] **Step 2: Run UI tests and confirm failure**

Run: `node --test tests/event-sync-ui.test.js`

Expected: FAIL for missing UI model exports.

- [ ] **Step 3: Implement event destinations and state display**

Add `eventAllDay` and `eventCalendar` controls. Extend repeat options with `monthly` and `yearly`. For Family-Hub-only events retain the existing Supabase writes. For a selected Google destination, call `save_google_backed_event` so event, mapping, and queue are atomic.

Render **Synced**, **Syncing**, **Needs attention**, or **Read only** on event cards and in the edit dialog. **Needs attention** exposes a retry button calling the manual sync endpoint. Hide `sync_deleted_at` events from normal views.

For delete-everywhere, use the exact explicit warning and call `request_google_event_delete`; close the dialog only after the local pending-delete transaction succeeds. For read-only mappings, disable Google-owned fields and deletion while leaving `eventPerson` editable through a local-only update.

- [ ] **Step 4: Verify tests and regression scenarios**

Run: `npm test && node --check app.js && node --check lib/google-ui.js`

Expected: all checks pass.

Manual: create/edit/delete a Family-Hub-only event; create a queued Google event; reassign an imported event to a child; inspect each sync state; verify a read-only imported event allows only person reassignment.

- [ ] **Step 5: Commit**

```bash
git add index.html styles.css app.js lib/google-ui.js tests/event-sync-ui.test.js
git commit -m "feat: integrate Google sync into event workflows"
```

### Task 13: Implement Reconnect and Disconnect Choices

**Files:**
- Create: `supabase/functions/google-disconnect/index.ts`
- Create: `tests/google-disconnect-contract.test.js`
- Modify: `lib/google-ui.js`
- Modify: `index.html`
- Modify: `app.js`

**Interfaces:**
- Produces authenticated `POST /google-disconnect` with `{ mode:"keep_local"|"remove_local" }`.
- Consumes: connection ownership, mappings, queued work, and encrypted credentials.

- [ ] **Step 1: Write failing disconnect contracts**

Verify only the connection owner can disconnect. `keep_local` removes mappings/queue state while retaining events as Family-Hub-only. `remove_local` removes imported Family Hub copies without calling Google delete. Both modes revoke the Google token best-effort, erase encrypted credentials, and leave Google events untouched.

- [ ] **Step 2: Run disconnect tests and confirm failure**

Run: `node --test tests/google-disconnect-contract.test.js`

Expected: FAIL because the handler is absent.

- [ ] **Step 3: Implement reconnect and disconnect flows**

Render **Reconnect Google Calendar** when connection state is `reconnect_required`; reconnect reuses OAuth and upserts the same `(user_id, google_account_id)` connection. Disconnect uses a dialog with two explicit actions: **Keep Family Hub copies** and **Remove Family Hub copies**. Neither action sends Google event deletion requests.

Run database cleanup transactionally after best-effort Google token revocation. If revocation is unavailable, still erase local encrypted credentials and complete disconnect.

- [ ] **Step 4: Run tests and manual flow checks**

Run: `npm test && node --check app.js && node --check lib/google-ui.js`

Expected: all checks pass.

Manual: simulate revoked auth, reconnect, disconnect with retained local copies, and disconnect with removed local copies; verify Google mock receives no event-delete requests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/google-disconnect tests/google-disconnect-contract.test.js lib/google-ui.js index.html app.js
git commit -m "feat: add Google reconnect and disconnect flows"
```

### Task 14: Finish Deployment Documentation, Cache Busting, and End-to-End Verification

**Files:**
- Modify: `README.txt`
- Modify: `sw.js`
- Modify: `index.html:175-176`
- Create: `docs/google-calendar-rollout-checklist.md`
- Create: `tests/pwa-assets.test.js`

**Interfaces:**
- Consumes: all preceding implementation tasks.
- Produces: deployable configuration instructions and controlled rollout checklist.

- [ ] **Step 1: Write a failing PWA asset contract**

```js
test("service worker caches every local browser module", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  for (const asset of ["./app.js", "./lib/calendar-domain.js", "./lib/google-event-model.js", "./lib/sync-policy.js", "./lib/google-ui.js"])
    assert.match(sw, new RegExp(asset.replace(/[./]/g, "\\$&")));
  assert.match(sw, /family-hub-v3/);
});
```

- [ ] **Step 2: Run PWA test and confirm failure**

Run: `node --test tests/pwa-assets.test.js`

Expected: FAIL until cache name and module assets are updated.

- [ ] **Step 3: Update cache and deployment documentation**

Set `CACHE="family-hub-v3"`, add all local browser modules to `ASSETS`, and update the `app.js` query version in `index.html` to `v=3`.

Document these exact deployment steps in `README.txt`:

1. Create Google OAuth web credentials with the deployed callback URL.
2. Configure the eight server secrets listed in Task 5.
3. Apply both migrations in order.
4. Deploy all Edge Functions.
5. Set Vault secrets `project_url` and `google_sync_cron_secret`.
6. Enable the five-minute scheduled job.
7. Keep GitHub Pages `config.js` limited to Supabase URL and publishable key.

The rollout checklist must cover one adult and one dedicated writable test calendar: connect, enable, Google import, Family Hub create, edits in both directions, all-day dates, four recurrence frequencies, same-event conflict, read-only calendar, delete-everywhere, transient retry, revoked authorization, reconnect, both disconnect choices, duplicate replay, existing local-only events, realtime on a second browser, and service-worker refresh.

- [ ] **Step 4: Run complete automated verification**

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `node --check app.js; node --check sw.js; Get-ChildItem lib/*.js | ForEach-Object { node --check $_.FullName }`

Expected: every JavaScript file passes syntax checking.

Run: `git diff --check`

Expected: no whitespace errors.

Run when available: `Get-ChildItem supabase/functions/*/index.ts,supabase/functions/_shared/*.ts | ForEach-Object { deno check $_.FullName }`

Expected: no type errors.

Run when a non-production Supabase project and Google test credentials are configured: execute every item in `docs/google-calendar-rollout-checklist.md` and record date, tester, environment, and pass/fail result without recording secrets or private event content.

- [ ] **Step 5: Commit final rollout artifacts**

```bash
git add README.txt sw.js index.html docs/google-calendar-rollout-checklist.md tests/pwa-assets.test.js
git commit -m "docs: add Google Calendar rollout procedure"
```

### Task 15: Final Regression and Security Review

**Files:**
- Review: all changed files
- Modify only files required by discovered failures.

**Interfaces:**
- Consumes: completed Tasks 1-14.
- Produces: verified feature branch ready for human-controlled deployment.

- [ ] **Step 1: Run the full automated suite from a clean checkout state**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run syntax, type, migration, and secret scans**

Run:

```bash
node --check app.js
node --check sw.js
Get-ChildItem lib/*.js | ForEach-Object { node --check $_.FullName }
git diff --check main...HEAD
git grep -n -E 'GOOGLE_CLIENT_SECRET=|SUPABASE_SERVICE_ROLE_KEY=|GOOGLE_TOKEN_ENCRYPTION_KEY=|refresh_token["[:space:]]*:' -- ':!docs/superpowers/**' ':!tests/**'
```

Expected: syntax and whitespace checks pass; secret scan returns no committed values or token literals.

Run when available: `supabase db reset` followed by `Get-ChildItem supabase/functions/*/index.ts,supabase/functions/_shared/*.ts | ForEach-Object { deno check $_.FullName }`.

Expected: migrations apply and Edge Functions type-check.

- [ ] **Step 3: Perform focused code review against the spec**

Confirm each acceptance criterion has an automated test or a named controlled-rollout check. Confirm browser code cannot select credential columns, all privileged handlers derive user identity from JWTs, every remote display string uses `textContent`, every queue path is idempotent, and no Google error body is exposed directly to users.

- [ ] **Step 4: Fix discovered defects test-first and rerun affected plus full tests**

For each defect, add a test that reproduces it, run the focused test to observe failure, implement the smallest correction, run the focused test, then run `npm test`. Do not combine unrelated corrections in one commit.

- [ ] **Step 5: Commit review fixes and report deployment prerequisites**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: clean worktree and a reviewable sequence of focused commits. Report separately any checks requiring the user's non-production Supabase project, Google Cloud OAuth credentials, or deployment secrets; do not claim those checks passed until they actually run.
