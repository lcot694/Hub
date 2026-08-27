import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// PostgreSQL is unavailable in this workspace. These source contracts guard
// the migration shape but do not replace deployment database/RPC smoke tests.
const migration = new URL("../supabase/migrations/202608260001_google_sync_schema.sql", import.meta.url);

async function functionBody(name) {
  const sql = await readFile(migration, "utf8");
  const match = sql.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "i"
  ));
  assert.ok(match, `${name} must be defined`);
  return match[0];
}

test("save_google_backed_event authenticates and transactionally creates the event, mapping, and create job", async () => {
  const sql = await functionBody("save_google_backed_event");

  assert.match(sql, /p_event jsonb/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /auth\.uid\(\) is null/i);
  assert.match(sql, /public\.is_household_member\(v_household_id\)/i);
  assert.match(sql, /c\.user_id = auth\.uid\(\)/i);
  assert.match(sql, /c\.connection_state = 'active'/i);
  assert.match(sql, /cal\.enabled and cal\.is_writable/i);
  assert.match(sql, /insert into public\.events/i);
  assert.match(sql, /insert into public\.google_event_mappings/i);
  assert.match(sql, /enqueue_google_event_change_internal\(v_event_id, 'create'\)/i);
  assert.match(sql, /errcode = '22023'/i, "invalid IDs and JSON must have a stable validation code");
  assert.match(sql, /errcode = '42501'/i, "authorization failures must have a stable permission code");
});

test("save_google_backed_event requires mandatory JSON keys and normalizes UUID/date/time casts to validation errors", async () => {
  const sql = await functionBody("save_google_backed_event");

  for (const key of ["household_id", "google_calendar_id", "title", "event_date", "all_day", "recurrence"]) {
    assert.match(sql, new RegExp(`p_event \\? '${key}'`, "i"), `${key} must be explicitly present`);
  }
  for (const condition of ["invalid_text_representation", "invalid_datetime_format", "datetime_field_overflow"]) {
    assert.match(sql, new RegExp(`exception when[\\s\\S]*${condition}`, "i"), `${condition} must become a safe validation error`);
  }
  assert.match(sql, /22P02[\s\S]*22007[\s\S]*22008/i,
    "the migration must document the concrete cast SQLSTATEs normalized to 22023");
  assert.match(sql, /exception when[\s\S]*errcode = '22023'\s*,\s*message = 'google_event_invalid_payload'/i);
});

test("save_google_backed_event locks an existing event and mapping before its queue mutation", async () => {
  const sql = await functionBody("save_google_backed_event");

  assert.match(sql, /from public\.events e[\s\S]*for update of e/i);
  assert.match(sql, /from public\.google_event_mappings m[\s\S]*for update of m/i);
  assert.match(sql, /perform public\.enqueue_google_event_change_internal\(v_event_id, 'update'\)/i);
});

test("existing mapped-event save locks event, mapping, then connection and calendar", async () => {
  const sql = await functionBody("save_google_backed_event");
  const existingEdit = sql.slice(sql.indexOf("select e.* into v_existing_event"));
  const eventLock = existingEdit.indexOf("for update of e");
  const mappingLock = existingEdit.indexOf("for update of m");
  const destinationLock = existingEdit.indexOf("for update of c, cal");

  assert.ok(eventLock >= 0 && mappingLock > eventLock && destinationLock > mappingLock,
    "existing edits must lock event → mapping → connection/calendar before queue work");
});

test("queue helper follows event, mapping, connection/calendar, then queue lock order", async () => {
  const sql = await functionBody("enqueue_google_event_change_internal");
  const eventLock = sql.indexOf("for update of e");
  const mappingLock = sql.indexOf("for update of m");
  const destinationLock = sql.indexOf("for update of c, cal");
  const queueLock = sql.indexOf("from public.google_sync_queue q");

  assert.ok(eventLock >= 0 && mappingLock > eventLock && destinationLock > mappingLock && queueLock > destinationLock,
    "queue helper must retain the documented event → mapping → connection/calendar → queue order");
});

test("trigger-side Google field guard requires the caller's active writable enabled mapping", async () => {
  const sql = await functionBody("assert_google_event_change_allowed");

  assert.match(sql, /from public\.google_event_mappings m/i);
  assert.match(sql, /c\.user_id = auth\.uid\(\)/i);
  assert.match(sql, /c\.connection_state = 'active'/i);
  assert.match(sql, /cal\.enabled and cal\.is_writable/i);
  assert.match(sql, /if exists[\s\S]*google_event_mappings[\s\S]*and not exists/i,
    "unmapped Family-Hub-only events may retain direct writes while mapped events require the full guard");
});

test("pending queue supersession preserves the latest required Google operation", async () => {
  const sql = await functionBody("enqueue_google_event_change_internal");

  assert.match(sql, /when public\.google_sync_queue\.operation = 'delete' then 'delete'/i,
    "a delete must not be replaced by an update");
  assert.match(sql, /when excluded\.operation = 'delete' then 'delete'/i,
    "an update followed by delete must become delete");
  assert.match(sql, /when public\.google_sync_queue\.operation = 'create' then 'create'/i,
    "a create followed by update must remain a create carrying current event data");
  assert.match(sql, /else excluded\.operation/i,
    "repeated updates must remain updates");
});

test("request_google_event_delete only cancels a never-attempted pending create locally", async () => {
  const sql = await functionBody("request_google_event_delete");

  assert.match(sql, /auth\.uid\(\) is null/i);
  assert.match(sql, /from public\.events e[\s\S]*for update of e/i);
  assert.match(sql, /from public\.google_event_mappings m[\s\S]*for update of m/i);
  assert.match(sql, /set sync_deleted_at = clock_timestamp\(\)/i);
  assert.match(sql, /enqueue_google_event_change_internal\(p_family_event_id, 'delete'\)/i);
  assert.match(sql, /v_pending_create_id is not null/i);
  assert.match(sql, /q\.attempt_count = 0/i);
  assert.match(sql, /not exists \([\s\S]*q_attempt[\s\S]*q_attempt\.status = 'processing'[\s\S]*q_attempt\.attempt_count > 0/i);
  assert.match(sql, /delete from public\.google_sync_queue/i);
  assert.match(sql, /delete from public\.google_event_mappings/i);
  assert.match(sql, /delete from public\.events/i);
  assert.match(sql, /errcode = '42501'/i);
});

test("an attempted or ambiguous create-delete path preserves mapping identity and promotes a delete", async () => {
  const sql = await functionBody("request_google_event_delete");
  const cancellation = sql.slice(sql.indexOf("if v_pending_create_id is not null"), sql.indexOf("update public.events"));
  const attemptedDelete = sql.slice(sql.indexOf("update public.events"));

  assert.doesNotMatch(cancellation, /attempt_count > 0/i,
    "the local-finalization branch must exclude attempted creates");
  assert.match(attemptedDelete, /set sync_deleted_at = clock_timestamp\(\)/i);
  assert.match(attemptedDelete, /enqueue_google_event_change_internal\(p_family_event_id, 'delete'\)/i);
  assert.doesNotMatch(attemptedDelete, /delete from public\.google_event_mappings/i,
    "ambiguous creates retain their stable mapping identity for a remote delete");
});

test("mapped-event deletion locks event, mapping, then connection and calendar", async () => {
  const sql = await functionBody("request_google_event_delete");
  const eventLock = sql.indexOf("for update of e");
  const mappingLock = sql.indexOf("for update of m");
  const destinationLock = sql.indexOf("for update of c, cal");

  assert.ok(eventLock >= 0 && mappingLock > eventLock && destinationLock > mappingLock,
    "deletion must use the same event → mapping → connection/calendar lock order as save");
});
