import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createServiceClient, requiredServerEnv } from "../_shared/db.ts";
import { pullCalendar, type PullCalendar, type PullDependencies } from "../_shared/pull-worker.ts";
import { processPushJob, type ClaimedPushJob, type PushDependencies } from "../_shared/push-worker.ts";
import { json } from "../_shared/http.ts";

const CALENDAR_BATCH = 10;
const JOB_BATCH = 25;
const LEASE_SECONDS = 300;

export interface ScheduledSyncStore {
  listDueCalendars(limit: number): Promise<PullCalendar[]>;
  claimJobs(limit: number, leaseSeconds: number): Promise<ClaimedPushJob[]>;
  pullDependencies?: PullDependencies;
  pushDependencies?: PushDependencies;
}
export interface ScheduledSyncDependencies {
  env?: (name: string) => string | undefined;
  store?: ScheduledSyncStore;
  database?: SupabaseClient;
  pull?: (calendar: PullCalendar) => Promise<unknown>;
  push?: (job: ClaimedPushJob) => Promise<unknown>;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function constantSafeSecretEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

function databaseStore(database: SupabaseClient): ScheduledSyncStore {
  return {
    async listDueCalendars(limit) {
      const { data, error } = await database.rpc("claim_google_sync_calendars", { p_limit: limit });
      if (error) throw new Error("Calendar batch unavailable");
      return (data ?? []) as PullCalendar[];
    },
    async claimJobs(limit, leaseSeconds) {
      const { data, error } = await database.rpc("claim_google_sync_jobs", { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw new Error("Queue batch unavailable");
      return (data ?? []) as ClaimedPushJob[];
    },
  };
}

function bearer(req: Request): string {
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.get("Authorization") ?? "");
  return match?.[1] ?? "";
}

export function createScheduledSyncHandler(dependencies: ScheduledSyncDependencies = {}) {
  return async function handleScheduledSync(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const configured = dependencies.env?.("SYNC_CRON_SECRET") ?? requiredServerEnv("SYNC_CRON_SECRET");
    if (!await constantSafeSecretEqual(bearer(req), configured)) return json(401, { error: "unauthorized" });
    try {
      const store = dependencies.store ?? databaseStore(dependencies.database ?? createServiceClient());
      const calendars = await store.listDueCalendars(CALENDAR_BATCH);
      const pull = dependencies.pull ?? ((calendar) => pullCalendar(calendar, store.pullDependencies!));
      for (const calendar of calendars) await pull(calendar);
      const jobs = await store.claimJobs(JOB_BATCH, LEASE_SECONDS);
      const push = dependencies.push ?? ((job) => processPushJob(job, store.pushDependencies!));
      for (const job of jobs) await push(job);
      return json(200, {
        calendarsProcessed: calendars.length,
        jobsProcessed: jobs.length,
        workRemaining: calendars.length === CALENDAR_BATCH || jobs.length === JOB_BATCH,
      });
    } catch {
      return json(503, { error: "sync_unavailable" });
    }
  };
}

export const handleScheduledSync = createScheduledSyncHandler();
if (typeof Deno !== "undefined") Deno.serve(handleScheduledSync);
