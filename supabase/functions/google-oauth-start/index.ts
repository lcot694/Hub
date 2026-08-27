import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { createServiceClient, requiredServerEnv } from "../_shared/db.ts";
import { corsHeaders, handleCors, HttpError, json } from "../_shared/http.ts";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];
const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OAuthStartDependencies {
  authenticate?: typeof requireUser;
  database?: SupabaseClient;
  env?: (name: string) => string;
  now?: () => Date;
}

interface OAuthStartInput {
  householdId: string;
  personId: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function readInput(req: Request): Promise<OAuthStartInput> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid_request", "A JSON request body is required");
  }

  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate?.householdId !== "string" ||
    typeof candidate?.personId !== "string" ||
    !UUID_PATTERN.test(candidate.householdId) ||
    !UUID_PATTERN.test(candidate.personId)
  ) {
    throw new HttpError(400, "invalid_request", "A valid household and person are required");
  }

  return { householdId: candidate.householdId, personId: candidate.personId };
}

async function verifyOwnedPerson(
  database: SupabaseClient,
  userId: string,
  householdId: string,
  personId: string,
): Promise<void> {
  const membership = await database
    .from("household_members")
    .select("household_id")
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membership.error || !membership.data) {
    throw new HttpError(403, "household_not_allowed", "Household is not available");
  }

  const person = await database
    .from("people")
    .select("id")
    .eq("household_id", householdId)
    .eq("id", personId)
    .maybeSingle();
  if (person.error || !person.data) {
    throw new HttpError(400, "person_not_in_household", "Person is not in the household");
  }
}

export async function handleOAuthStart(
  req: Request,
  dependencies: OAuthStartDependencies = {},
): Promise<Response> {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  let responseHeaders: Headers;
  try {
    responseHeaders = corsHeaders(req);
    if (req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "POST is required");
    }

    const authenticate = dependencies.authenticate ?? requireUser;
    const database = dependencies.database ?? createServiceClient();
    const env = dependencies.env ?? requiredServerEnv;
    const now = dependencies.now ?? (() => new Date());
    const { userId } = await authenticate(req);
    const { householdId, personId } = await readInput(req);
    await verifyOwnedPerson(database, userId, householdId, personId);

    const state = randomBase64Url(32);
    const pkceVerifier = randomBase64Url(64);
    const [stateHash, codeChallenge] = await Promise.all([
      sha256Base64Url(state),
      sha256Base64Url(pkceVerifier),
    ]);
    const redirectUri = env("GOOGLE_OAUTH_REDIRECT_URI");
    const expiresAt = new Date(now().getTime() + FLOW_LIFETIME_MS).toISOString();

    // This private legacy column carries callback-only context. It is never
    // interpreted as a URL or used to choose the eventual app redirect.
    const flowContext = JSON.stringify({ version: 1, personId, pkceVerifier });
    const { error: flowError } = await database.from("google_oauth_flows").insert({
      user_id: userId,
      household_id: householdId,
      state_hash: stateHash,
      redirect_path: flowContext,
      expires_at: expiresAt,
    });
    if (flowError) {
      throw new HttpError(503, "oauth_unavailable", "Google connection could not be started");
    }

    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorizationUrl.searchParams.set("client_id", env("GOOGLE_CLIENT_ID"));
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    return json(200, { authorizationUrl: authorizationUrl.toString() }, responseHeaders);
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.code }, { Vary: "Origin" });
    }
    return json(500, { error: "internal_error" }, { Vary: "Origin" });
  }
}

if (typeof Deno !== "undefined") {
  Deno.serve(handleOAuthStart);
}
