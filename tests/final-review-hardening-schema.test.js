import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202609080001_google_sync_final_hardening.sql", import.meta.url);
const reconnectFenceUrl = new URL("../supabase/migrations/202609080002_google_reconnect_failure_fence.sql", import.meta.url);

async function migration() { return await readFile(migrationUrl, "utf8"); }

test("forward migration adds an authoritative Google-owned Family revision with upgrade backfill", async () => {
  const sql = await migration();
  assert.match(sql, /add column if not exists google_sync_updated_at timestamptz/i);
  assert.match(sql, /add column if not exists google_sync_version bigint/i);
  assert.match(sql, /update public\.events[\s\S]*google_sync_updated_at\s*=\s*coalesce\(google_sync_updated_at,\s*updated_at/i);
  assert.match(sql, /google_sync_version\s*=\s*coalesce\(google_sync_version,\s*1\)/i);
  assert.match(sql, /new\.person_id is distinct from old\.person_id[\s\S]*return new/i);
  assert.match(sql, /new\.google_sync_updated_at\s*:=\s*clock_timestamp\(\)/i);
  assert.match(sql, /new\.google_sync_version\s*:=\s*old\.google_sync_version\s*\+\s*1/i);
});

test("push completion is snapshot-CAS fenced and preserves successor queue work", async () => {
  const sql = await migration();
  const complete = sql.match(/create or replace function public\.complete_google_push_job[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  assert.match(complete, /expectedEventVersion/i);
  assert.match(complete, /expectedMappingUpdatedAt/i);
  assert.match(complete, /v_event\.google_sync_version\s*<>\s*v_expected_event_version/i);
  assert.match(complete, /v_mapping\.updated_at\s*<>\s*v_expected_mapping_updated_at/i);
  assert.match(complete, /exists\s*\([\s\S]*successor[\s\S]*status\s+in\s*\('pending','processing'\)/i);
  assert.match(complete, /stale_google_push_completion/i);
});

test("full reconciliation excludes unresolved and never-confirmed mappings and applies conflict policy", async () => {
  const sql = await migration();
  const begin = sql.match(/create or replace function public\.begin_google_full_reconciliation[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  const finish = sql.match(/create or replace function public\.finish_google_full_reconciliation[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  assert.match(begin, /last_google_updated_at is not null/i);
  assert.match(begin, /not exists\s*\([\s\S]*google_sync_queue[\s\S]*status in \('pending','processing','failed'\)/i);
  assert.match(finish, /google_sync_updated_at/i);
  assert.match(finish, /last_family_updated_at/i);
  assert.match(finish, /sync_state\s*=\s*'needs_attention'/i);
  assert.match(finish, /enqueue_google_event_change_internal[\s\S]*'update'/i);
});

test("refresh persistence is fenced by generation account and active connection state", async () => {
  const sql = await migration();
  assert.match(sql, /create or replace function public\.persist_google_refreshed_tokens/i);
  assert.match(sql, /oauth_generation\s*=\s*p_oauth_generation/i);
  assert.match(sql, /google_account_id\s*=\s*p_google_account_id/i);
  assert.match(sql, /connection_state\s*=\s*'active'/i);
  assert.match(sql, /grant execute on function public\.persist_google_refreshed_tokens[\s\S]*to service_role/i);
});

test("manual retry and reconnect requeue only eligible latest failed work", async () => {
  const sql = await migration();
  assert.match(sql, /create or replace function public\.requeue_google_failed_jobs/i);
  assert.match(sql, /q\.status\s*=\s*'failed'/i);
  assert.match(sql, /not exists\s*\([\s\S]*newer[\s\S]*created_at\s*>\s*q\.created_at/i);
  assert.match(sql, /case when eligible\.sync_deleted_at is not null then 'delete'/i);
  assert.match(sql, /perform public\.requeue_google_failed_jobs/i);
});

test("read-only mappings are enforced transactionally for save delete and worker context", async () => {
  const sql = await migration();
  const base = await readFile(new URL("../supabase/migrations/202608270005_remove_sync_guc_upgrade.sql", import.meta.url), "utf8");
  assert.match(sql, /enqueue_google_event_change_internal[\s\S]*assert_google_mapping_writable/i);
  assert.match(sql, /load_google_push_context[\s\S]*m\.sync_state\s*<>\s*'read_only'/i);
  for (const routine of ["save_google_backed_event", "request_google_event_delete"]) {
    const body = base.match(new RegExp(`create or replace function public\\.${routine}[\\s\\S]*?\\n\\$\\$;`, "i"))?.[0] ?? "";
    assert.match(body, /enqueue_google_event_change_internal/i, `${routine} must pass through the transactional writable guard`);
  }
});

test("visible status is queue-derived and tombstoned failures have an authenticated retry surface", async () => {
  const sql = await migration();
  const status = sql.match(/create(?: or replace)? function public\.get_google_sync_status[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  assert.match(status, /google_sync_queue/i);
  assert.match(status, /sync_deleted_at/i);
  assert.match(sql, /create or replace function public\.retry_google_event_sync/i);
  assert.match(sql, /public\.is_household_member/i);
  assert.match(sql, /safe_error_message/i);
  assert.doesNotMatch(status, /access_token_encrypted|refresh_token_encrypted/);
});

test("server-side mapped saves reject recurrence anchors Google cannot represent", async () => {
  const sql = await migration();
  const enqueue = sql.match(/create or replace function public\.enqueue_google_event_change_internal[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  assert.match(enqueue, /extract\(day from .*event_date\)\s*>\s*28/i);
  assert.match(enqueue, /recurrence='yearly'[\s\S]*02-29/i);
  assert.match(enqueue, /google_recurrence_not_representable/i);
});

test("stale authorization bookkeeping is generation fenced and supersedes only its leased work", async () => {
  const sql = await readFile(reconnectFenceUrl, "utf8");
  assert.match(sql, /mark_google_connection_reconnect\(\s*p_connection_id uuid,p_user_id uuid,p_google_account_id text,p_oauth_generation bigint\)/i);
  assert.match(sql, /google_account_id=p_google_account_id[\s\S]*oauth_generation=p_oauth_generation[\s\S]*connection_state='active'/i);
  assert.match(sql, /supersede_stale_google_push_job[\s\S]*claim_token=p_claim_token[\s\S]*status='processing'/i);
  assert.match(sql, /cancel_stale_google_pull[\s\S]*updated_at=p_expected_sync_version/i);
  assert.match(sql, /revoke all on function public\.mark_google_connection_reconnect\(uuid,uuid\)/i);
  assert.match(sql, /set search_path = public/ig);
});
