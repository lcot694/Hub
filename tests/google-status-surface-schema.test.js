import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202608270003_google_event_status_surface.sql", import.meta.url);

test("household status RPC includes every mapped household event and exposes current-user ownership separately", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /public\.is_household_member\(e\.household_id\)/i);
  assert.match(sql, /e\.household_id\s*=\s*p_household_id/i);
  assert.doesNotMatch(sql, /where\s+c\.user_id\s*=\s*auth\.uid\(\)/i);
  assert.match(sql, /c\.user_id\s*=\s*auth\.uid\(\)\s+as mapping_owned/i);
  assert.match(sql, /as mapping_can_edit/i);
  assert.doesNotMatch(sql, /access_token|refresh_token|google_etag/i);
});

test("safe household status surface is realtime-published and maintained by mapping updates", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table public\.google_event_sync_status/i);
  assert.match(sql, /create policy google_event_sync_status_select/i);
  assert.match(sql, /public\.is_household_member\(household_id\)/i);
  assert.match(sql, /create trigger google_event_mapping_status_refresh[\s\S]*after insert or update or delete/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.google_event_sync_status/i);
  assert.doesNotMatch(sql, /google_event_id|google_etag|display_email|token/i);
});
