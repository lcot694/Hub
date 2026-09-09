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

test("migration fences queue workers and preserves secure pending successors", async () => {
  const sql = await readFile(sqlPath, "utf8");

  for (const token of [
    "claim_token uuid",
    "claim_token = gen_random_uuid()",
    "for update of m",
    "on conflict (family_event_id) where status = 'pending'",
    "create unique index google_sync_queue_one_pending_event_idx",
    "create unique index google_sync_queue_one_processing_event_idx",
    "public.enqueue_google_event_change_internal",
    "and not cal.is_writable",
    "public.assert_google_event_change_allowed(new.id)",
    "public.assert_google_event_change_allowed(p_family_event_id)"
  ]) assert.match(sql.toLowerCase(), new RegExp(token.replace(/[()]/g, "\\$&")));

  assert.match(sql, /complete_google_sync_job\(\s*p_job_id uuid,\s*p_claim_token uuid\s*\)/i);
  assert.match(sql, /fail_google_sync_job\(\s*p_job_id uuid,\s*p_claim_token uuid,/i);
  assert.match(sql, /and claim_token = p_claim_token/i);
  assert.match(sql, /and lease_expires_at > clock_timestamp\(\)/i);
  assert.match(sql, /and \(\s*q\.status = 'processing'\s+or not exists \(/i);
  assert.match(sql, /when exists \(\s*select 1\s*from public\.google_sync_queue successor/i);
  assert.doesNotMatch(
    sql.match(/create or replace function public\.enqueue_google_event_change\([\s\S]*?\n\$\$;/i)?.[0] || "",
    /is_household_member|auth\.uid\(\)/i
  );
});
