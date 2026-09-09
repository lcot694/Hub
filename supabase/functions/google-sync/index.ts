import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/db.ts";
import { corsHeaders, handleCors, HttpError, json } from "../_shared/http.ts";

type SyncReason = "manual" | "app_open";
interface SyncRequestResult { accepted: boolean; connectionId: string | null }
export interface AuthenticatedSyncStore {
  request(userId: string, reason: SyncReason): Promise<SyncRequestResult>;
}
export interface GoogleSyncDependencies {
  authenticate?: typeof requireUser;
  store?: AuthenticatedSyncStore;
  database?: SupabaseClient;
  runConnection?: (connectionId: string) => Promise<void>;
  defer?: (work: () => Promise<void>) => unknown;
}

function databaseStore(database: SupabaseClient): AuthenticatedSyncStore {
  return {
    async request(userId, reason) {
      const { data, error } = await database.rpc("request_google_sync", {
        p_user_id: userId, p_reason: reason,
      });
      if (error || !Array.isArray(data) || data.length > 1) {
        throw new HttpError(503, "sync_unavailable", "Calendar synchronization is unavailable");
      }
      if (!data.length) return { accepted: false, connectionId: null };
      return { accepted: Boolean(data[0].accepted), connectionId: data[0].connection_id ?? null };
    },
  };
}

function defaultDefer(work: () => Promise<void>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<void>) => void } }).EdgeRuntime;
  const pending = work().catch(() => {});
  runtime?.waitUntil?.(pending);
}

async function readReason(req: Request): Promise<SyncReason> {
  let body: unknown;
  try { body = await req.json(); } catch { throw new HttpError(400, "invalid_request", "A JSON request body is required"); }
  const reason = (body as { reason?: unknown })?.reason;
  if (reason !== "manual" && reason !== "app_open") {
    throw new HttpError(400, "invalid_request", "A valid sync reason is required");
  }
  return reason;
}

function httpFailure(error: unknown, headers: Headers): Response {
  if (error instanceof HttpError) return json(error.status, { error: error.code }, headers);
  const status = Number((error as { status?: unknown })?.status);
  const code = (error as { code?: unknown })?.code;
  if (Number.isInteger(status) && status >= 400 && status <= 599 && typeof code === "string") {
    return json(status, { error: code }, headers);
  }
  return json(500, { error: "internal_error" }, headers);
}

export function createGoogleSyncHandler(dependencies: GoogleSyncDependencies = {}) {
  return async function handleGoogleSync(req: Request): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;
    let headers = new Headers({ Vary: "Origin" });
    try {
      headers = corsHeaders(req);
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "POST is required");
      const { userId } = await (dependencies.authenticate ?? requireUser)(req);
      const reason = await readReason(req);
      const store = dependencies.store ?? databaseStore(dependencies.database ?? createServiceClient());
      const result = await store.request(userId, reason);
      if (result.accepted && result.connectionId && dependencies.runConnection) {
        (dependencies.defer ?? defaultDefer)(() => dependencies.runConnection!(result.connectionId!));
      }
      return json(202, { status: "syncing" }, headers);
    } catch (error) {
      return httpFailure(error, headers);
    }
  };
}

export const handleGoogleSync = createGoogleSyncHandler();
if (typeof Deno !== "undefined") Deno.serve(handleGoogleSync);
