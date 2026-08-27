import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

test("save_google_backed_event locks an existing event and mapping before its queue mutation", async () => {
  const sql = await functionBody("save_google_backed_event");

  assert.match(sql, /from public\.events e[\s\S]*for update of e/i);
  assert.match(sql, /from public\.google_event_mappings m[\s\S]*for update of m/i);
  assert.match(sql, /perform public\.enqueue_google_event_change_internal\(v_event_id, 'update'\)/i);
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

test("request_google_event_delete locks first, queues a recoverable delete, and cancels an unpushed create locally", async () => {
  const sql = await functionBody("request_google_event_delete");

  assert.match(sql, /auth\.uid\(\) is null/i);
  assert.match(sql, /from public\.events e[\s\S]*for update of e/i);
  assert.match(sql, /from public\.google_event_mappings m[\s\S]*for update of m/i);
  assert.match(sql, /set sync_deleted_at = clock_timestamp\(\)/i);
  assert.match(sql, /enqueue_google_event_change_internal\(p_family_event_id, 'delete'\)/i);
  assert.match(sql, /v_pending_create_id is not null/i);
  assert.match(sql, /delete from public\.google_sync_queue/i);
  assert.match(sql, /delete from public\.google_event_mappings/i);
  assert.match(sql, /delete from public\.events/i);
  assert.match(sql, /errcode = '42501'/i);
});
