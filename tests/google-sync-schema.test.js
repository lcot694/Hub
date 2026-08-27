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
