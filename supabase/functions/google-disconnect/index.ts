import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { decryptToken } from "../_shared/crypto.ts";
import { createServiceClient, requiredServerEnv } from "../_shared/db.ts";
import { corsHeaders, handleCors, HttpError, json } from "../_shared/http.ts";

export type DisconnectMode = "keep_local" | "remove_local";

interface DisconnectConnection {
  id: string;
  user_id: string;
  household_id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
}

export interface DisconnectStore {
  loadOwnedConnection(userId: string): Promise<DisconnectConnection | null>;
  disconnect(connectionId: string, userId: string, mode: DisconnectMode): Promise<void>;
}

interface RevocationDependencies {
  decrypt?: typeof decryptToken;
  env?: (name: string) => string;
  fetch?: typeof fetch;
}

interface DisconnectDependencies {
  authenticate?: typeof requireUser;
  store?: DisconnectStore;
  database?: SupabaseClient;
  revokeToken?: (connection: DisconnectConnection) => Promise<void>;
}

export function createDisconnectStore(database: SupabaseClient): DisconnectStore {
  return {
    async loadOwnedConnection(userId) {
      const { data, error } = await database.from("google_connections")
        .select("id,user_id,household_id,access_token_encrypted,refresh_token_encrypted")
        .eq("user_id", userId).maybeSingle();
      if (error) throw new HttpError(503, "disconnect_unavailable", "Google Calendar could not be disconnected");
      return data as DisconnectConnection | null;
    },
    async disconnect(connectionId, userId, mode) {
      const { data, error } = await database.rpc("disconnect_google_calendar", {
        p_connection_id: connectionId,
        p_user_id: userId,
        p_mode: mode,
      });
      if (error || data !== true) throw new HttpError(503, "disconnect_unavailable", "Google Calendar could not be disconnected");
    },
  };
}

export async function revokeGoogleToken(
  connection: DisconnectConnection,
  dependencies: RevocationDependencies = {},
): Promise<void> {
  const encryptedToken = connection.refresh_token_encrypted ?? connection.access_token_encrypted;
  if (!encryptedToken) return;
  const decrypt = dependencies.decrypt ?? decryptToken;
  const env = dependencies.env ?? requiredServerEnv;
  const fetchImplementation = dependencies.fetch ?? fetch;
  const token = await decrypt(encryptedToken, env("GOOGLE_TOKEN_ENCRYPTION_KEY"));
  const response = await fetchImplementation("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Google token revocation failed");
}

async function readMode(req: Request): Promise<DisconnectMode> {
  let body: unknown;
  try { body = await req.json(); }
  catch { throw new HttpError(400, "invalid_request", "A disconnect choice is required"); }
  const mode = (body as { mode?: unknown })?.mode;
  if (mode !== "keep_local" && mode !== "remove_local") {
    throw new HttpError(400, "invalid_request", "A valid disconnect choice is required");
  }
  return mode;
}

export function createGoogleDisconnectHandler(dependencies: DisconnectDependencies = {}) {
  return async function handleGoogleDisconnect(req: Request): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;
    let headers = new Headers({ Vary: "Origin" });
    try {
      headers = corsHeaders(req);
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "POST is required");
      const { userId } = await (dependencies.authenticate ?? requireUser)(req);
      const mode = await readMode(req);
      const store = dependencies.store ?? createDisconnectStore(dependencies.database ?? createServiceClient());
      const connection = await store.loadOwnedConnection(userId);
      if (!connection) throw new HttpError(404, "connection_not_found", "Google connection was not found");
      try {
        await (dependencies.revokeToken ?? revokeGoogleToken)(connection);
      } catch {
        // Revocation is best-effort; local credential erasure must still complete.
      }
      await store.disconnect(connection.id, userId, mode);
      return json(200, { disconnected: true, mode }, headers);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.code }, headers);
      return json(500, { error: "internal_error" }, headers);
    }
  };
}

export const handleGoogleDisconnect = createGoogleDisconnectHandler();
if (typeof Deno !== "undefined") Deno.serve(handleGoogleDisconnect);
