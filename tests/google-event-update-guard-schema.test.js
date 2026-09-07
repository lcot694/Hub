import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const guardUrl = new URL("../supabase/migrations/202608270004_google_event_update_guard.sql", import.meta.url);
const baseUrl = new URL("../supabase/migrations/202608260001_google_sync_schema.sql", import.meta.url);

test("mapped event direct updates are restricted to the owning adult's person reassignment", async () => {
  const sql = await readFile(guardUrl, "utf8");
  assert.match(sql, /before update on public\.events/i);
  assert.match(sql, /auth\.role\(\)[\s\S]*service_role/i);
  assert.match(sql, /current_setting\('app\.skip_google_event_queue',\s*true\)/i);
  assert.match(sql, /v_owner_user_id\s*<>\s*auth\.uid\(\)/i);
  assert.match(sql, /new\.person_id is distinct from old\.person_id/i);
  for (const protectedColumn of ["id", "household_id", "created_by", "title", "event_date", "start_time", "end_time", "all_day", "recurrence", "recurrence_end", "sync_deleted_at", "updated_at"]) {
    assert.match(sql, new RegExp(`new\\.${protectedColumn} is distinct from old\\.${protectedColumn}`, "i"));
  }
  assert.match(sql, /p\.household_id\s*=\s*old\.household_id/i);
});

test("trusted delete-everywhere RPC marks its internal event update for the guard bypass", async () => {
  const sql = await readFile(baseUrl, "utf8");
  const requestDelete = sql.match(/create or replace function public\.request_google_event_delete[\s\S]*?\nend;\n\$\$;/i)?.[0] ?? "";
  assert.match(requestDelete, /set_config\('app\.skip_google_event_queue',\s*'on',\s*true\)[\s\S]*update public\.events[\s\S]*sync_deleted_at/i);
});

test("Family-only event updates bypass the mapped-event restriction", async () => {
  const sql = await readFile(guardUrl, "utf8");
  assert.match(sql, /if not found then\s+return new;/i);
});
