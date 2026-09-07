import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const guardUrl = new URL("../supabase/migrations/202608270004_google_event_update_guard.sql", import.meta.url);
const baseUrl = new URL("../supabase/migrations/202608260001_google_sync_schema.sql", import.meta.url);
const forwardUrl = new URL("../supabase/migrations/202608270005_remove_sync_guc_upgrade.sql", import.meta.url);

test("mapped event direct updates are restricted to the owning adult's person reassignment", async () => {
  const sql = await readFile(guardUrl, "utf8");
  assert.match(sql, /before update on public\.events/i);
  assert.match(sql, /security invoker/i);
  assert.doesNotMatch(sql, /current_setting|set_config/i);
  assert.match(sql, /current_user\s*<>\s*'authenticated'/i);
  assert.match(sql, /v_owner_user_id\s*<>\s*auth\.uid\(\)/i);
  assert.match(sql, /new\.person_id is distinct from old\.person_id/i);
  for (const protectedColumn of ["id", "household_id", "created_by", "title", "event_date", "start_time", "end_time", "all_day", "recurrence", "recurrence_end", "sync_deleted_at", "updated_at"]) {
    assert.match(sql, new RegExp(`new\\.${protectedColumn} is distinct from old\\.${protectedColumn}`, "i"));
  }
  assert.match(sql, /p\.household_id\s*=\s*old\.household_id/i);
});

test("trusted delete-everywhere RPC needs no custom transaction setting", async () => {
  const sql = await readFile(baseUrl, "utf8");
  const requestDelete = sql.match(/create or replace function public\.request_google_event_delete[\s\S]*?\nend;\n\$\$;/i)?.[0] ?? "";
  assert.doesNotMatch(requestDelete, /set_config|current_setting/i);
  assert.match(requestDelete, /update public\.events[\s\S]*sync_deleted_at/i);
});

test("no migration uses a user-spoofable setting to suppress authorization or queue work", async () => {
  const migrationNames = [
    "202608260001_google_sync_schema.sql",
    "202608260002_google_sync_schedule.sql",
    "202608270004_google_event_update_guard.sql",
  ];
  const sql = (await Promise.all(migrationNames.map((name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(sql, /app\.skip_google_event_queue|set_config\s*\(/i);
});

test("a later forward migration replaces every previously installed GUC-affected routine", async () => {
  const sql = await readFile(forwardUrl, "utf8");
  for (const routine of [
    "events_enqueue_google_change",
    "save_google_backed_event",
    "request_google_event_delete",
    "complete_google_push_job",
    "apply_google_pull_page",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${routine}\\s*\\(`, "i"), `${routine} must be superseded`);
  }
  assert.doesNotMatch(sql, /app\.skip_google_event_queue|set_config\s*\(|current_setting\s*\(/i);
  assert.match(sql, /security definer/ig);
  assert.match(sql, /set search_path = public/ig);
});

test("forward replacements preserve grants for browser and service-role entry points", async () => {
  const sql = await readFile(forwardUrl, "utf8");
  assert.match(sql, /grant execute on function public\.save_google_backed_event\(jsonb\) to authenticated/i);
  assert.match(sql, /grant execute on function public\.request_google_event_delete\(uuid\) to authenticated/i);
  assert.match(sql, /grant execute on function public\.complete_google_push_job\(uuid,uuid,jsonb\) to service_role/i);
  assert.match(sql, /grant execute on function public\.apply_google_pull_page\(uuid,jsonb,jsonb\) to service_role/i);
});

test("spoofing the removed GUC cannot authorize a direct mapped-event update", () => {
  const authorize = ({ effectiveRole, ownsMapping, protectedChange, personInHousehold }) =>
    effectiveRole !== "authenticated" || (ownsMapping && !protectedChange && personInHousehold);
  const spoofedSettings = { "app.skip_google_event_queue": "on" };
  assert.equal(authorize({ effectiveRole: "authenticated", ownsMapping: false, protectedChange: false, personInHousehold: true, spoofedSettings }), false);
  assert.equal(authorize({ effectiveRole: "authenticated", ownsMapping: true, protectedChange: true, personInHousehold: true, spoofedSettings }), false);
  assert.equal(authorize({ effectiveRole: "authenticated", ownsMapping: true, protectedChange: false, personInHousehold: true, spoofedSettings }), true);
});

test("Family-only event updates bypass the mapped-event restriction", async () => {
  const sql = await readFile(guardUrl, "utf8");
  assert.match(sql, /if v_owner_user_id is null then\s+return new;/i);
});
