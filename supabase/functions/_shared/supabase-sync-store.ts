import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  createGooglePullAdapter,
  type FullReconciliationScan,
  type MappedPullEvent,
  type PullCalendar,
  type PullChange,
  type PullDependencies,
  type PullErrorCategory,
  type PullPageReconciliation,
  type PullRunGuard,
  type PullStore,
} from "./pull-worker.ts";
import {
  createGooglePushAdapter,
  type ClaimedPushJob,
  type PushCompletion,
  type PushContext,
  type PushDependencies,
  type PushErrorCategory,
  type PushStore,
} from "./push-worker.ts";
import type { GoogleClientDependencies } from "./google-client.ts";

type RpcClient = Pick<SupabaseClient, "rpc">;

async function rpc<T>(database: RpcClient, name: string, parameters: Record<string, unknown>): Promise<T> {
  const { data, error } = await database.rpc(name, parameters);
  if (error) throw new Error("Google synchronization database operation failed");
  return data as T;
}

async function requiredRpc<T>(database: RpcClient, name: string, parameters: Record<string, unknown>): Promise<T> {
  const value = await rpc<T | null>(database, name, parameters);
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error("Google synchronization database operation failed");
  }
  return value;
}

export function createSupabasePushStore(database: RpcClient): PushStore {
  return {
    loadContext: (job: ClaimedPushJob) => requiredRpc<PushContext>(database, "load_google_push_context", {
      p_job_id: job.id,
      p_claim_token: job.claim_token,
    }),
    complete: (jobId: string, claimToken: string, completion: PushCompletion) => rpc<void>(
      database,
      "complete_google_push_job",
      { p_job_id: jobId, p_claim_token: claimToken, p_completion: completion },
    ),
    fail: (jobId: string, claimToken: string, category: PushErrorCategory, safeMessage: string, nextAttemptAt: string | null) => rpc<void>(
      database,
      "fail_google_sync_job",
      {
        p_job_id: jobId,
        p_claim_token: claimToken,
        p_error_category: category,
        p_safe_error_message: safeMessage,
        p_next_attempt_at: nextAttemptAt,
      },
    ),
    markReconnect: (connection) => rpc<boolean>(database, "mark_google_connection_reconnect", {
      p_connection_id: connection.id, p_user_id: connection.user_id,
      p_google_account_id: connection.google_account_id, p_oauth_generation: connection.oauth_generation,
    }),
    supersedeStaleAuthorization: (jobId, claimToken) => rpc<void>(database, "supersede_stale_google_push_job", {
      p_job_id: jobId, p_claim_token: claimToken,
    }),
  };
}

export function createSupabasePullStore(database: RpcClient): PullStore {
  return {
    loadMappedEvent: (calendar: PullCalendar, googleEventId: string) => rpc<MappedPullEvent | null>(
      database,
      "load_google_pull_mapping",
      { p_calendar_id: calendar.id, p_google_event_id: googleEventId },
    ),
    applyPage: (calendar: PullCalendar, changes: PullChange[], reconciliation: PullPageReconciliation) => rpc<void>(
      database,
      "apply_google_pull_page",
      { p_calendar_id: calendar.id, p_changes: changes, p_reconciliation: reconciliation },
    ),
    completeIncrementalPull: (calendar: PullCalendar, run: PullRunGuard, nextSyncToken: string, cancellations: string[]) => rpc<void>(
      database,
      "complete_google_incremental_pull",
      { p_calendar_id: calendar.id, p_run: run, p_next_sync_token: nextSyncToken, p_cancellations: cancellations },
    ),
    beginFullReconciliation: (calendar: PullCalendar, run: PullRunGuard) => requiredRpc<FullReconciliationScan>(
      database,
      "begin_google_full_reconciliation",
      { p_calendar_id: calendar.id, p_run: run },
    ),
    finishFullReconciliation: (calendar: PullCalendar, scan: FullReconciliationScan, nextSyncToken: string, cancellations: string[]) => rpc<void>(
      database,
      "finish_google_full_reconciliation",
      { p_calendar_id: calendar.id, p_scan: scan, p_next_sync_token: nextSyncToken, p_cancellations: cancellations },
    ),
    abortFullReconciliation: (calendar: PullCalendar, scan: FullReconciliationScan) => rpc<void>(
      database,
      "abort_google_full_reconciliation",
      { p_calendar_id: calendar.id, p_scan: scan },
    ),
    markReconnect: (connection) => rpc<boolean>(database, "mark_google_connection_reconnect", {
      p_connection_id: connection.id, p_user_id: connection.user_id,
      p_google_account_id: connection.google_account_id, p_oauth_generation: connection.oauth_generation,
    }),
    cancelStaleAuthorization: (calendar) => rpc<void>(database, "cancel_stale_google_pull", {
      p_calendar_id: calendar.id, p_expected_sync_version: calendar.sync_version,
    }),
    recordFailure: (calendar: PullCalendar, category: PullErrorCategory, safeMessage: string) => rpc<void>(
      database,
      "record_google_pull_failure",
      {
        p_calendar_id: calendar.id,
        p_run: { expectedSyncToken: calendar.sync_token, expectedSyncVersion: calendar.sync_version },
        p_error_category: category,
        p_safe_error_message: safeMessage,
      },
    ),
  };
}

export function createSupabaseWorkerDependencies(
  database: SupabaseClient,
  googleClient: GoogleClientDependencies = {},
): { pullDependencies: PullDependencies; pushDependencies: PushDependencies } {
  const client = { ...googleClient, database };
  return {
    pullDependencies: { store: createSupabasePullStore(database), google: createGooglePullAdapter(client) },
    pushDependencies: { store: createSupabasePushStore(database), google: createGooglePushAdapter(client) },
  };
}
