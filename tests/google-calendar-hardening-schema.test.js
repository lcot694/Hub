import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = new URL("../supabase/migrations/202608270002_google_calendar_hardening.sql", import.meta.url);
const baseMigration = new URL("../supabase/migrations/202608260001_google_sync_schema.sql", import.meta.url);

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

test("one-account uniqueness is present in the base schema and has an audited preflight before the hardening index", async () => {
  const [base, hardening] = await Promise.all([readFile(baseMigration, "utf8"), readFile(migration, "utf8")]);
  assert.match(base, /unique\s*\(user_id\)/i);
  assert.match(hardening, /google_connection_duplicate_users/);
  assert.ok(hardening.indexOf("google_connection_duplicate_users") < hardening.indexOf("google_connections_one_account_per_user_idx"));
});

test("contract: PostgreSQL functions keep each snapshot and selection replacement transactional", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /create or replace function public\.replace_google_calendar_snapshot[\s\S]*language plpgsql[\s\S]*insert into public\.google_calendars[\s\S]*update public\.google_calendars/i);
  assert.match(sql, /create or replace function public\.set_google_calendar_selection[\s\S]*language plpgsql[\s\S]*update public\.google_connections[\s\S]*update public\.google_calendars/i);
});
