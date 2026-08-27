import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = new URL("../supabase/migrations/202608270002_google_calendar_hardening.sql", import.meta.url);

test("calendar hardening migration enforces one account and atomically replaces snapshots and selections", async () => {
  const sql = await readFile(migration, "utf8");

  assert.match(sql, /unique index .*google_connections.*user_id/i);
  for (const rpc of [
    "replace_google_calendar_snapshot",
    "set_google_calendar_selection",
    "mark_google_connection_reconnect_required",
  ]) assert.match(sql, new RegExp(`function public\\.${rpc}`, "i"));
  assert.match(sql, /update public\.google_calendars[\s\S]*enabled = false/i);
  assert.match(sql, /raise exception 'Google calendar is not available to this user'/i);
  assert.match(sql, /grant execute[\s\S]*replace_google_calendar_snapshot[\s\S]*to service_role/i);
});
