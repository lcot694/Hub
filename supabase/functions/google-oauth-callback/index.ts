import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptToken } from "../_shared/crypto.ts";
import { createServiceClient, requiredServerEnv } from "../_shared/db.ts";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SANITIZED_ERROR_CODES = new Set([
  "authorization_denied",
  "invalid_request",
  "invalid_state",
  "token_exchange_failed",
  "account_lookup_failed",
  "connection_failed",
]);

type SanitizedErrorCode =
  | "authorization_denied"
  | "invalid_request"
  | "invalid_state"
  | "token_exchange_failed"
  | "account_lookup_failed"
  | "connection_failed";

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface OAuthCallbackDependencies {
  database?: SupabaseClient;
  env?: (name: string) => string;
  fetch?: FetchImplementation;
  now?: () => Date;
  encrypt?: typeof encryptToken;
}

interface FlowContext {
  personId: string;
  pkceVerifier: string;
}

interface ConsumedFlow {
  user_id: string;
  household_id: string;
  redirect_path: string;
}

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface GoogleUserInfo {
  sub: string;
  email: string | null;
}

class OAuthCallbackError extends Error {
  readonly code: SanitizedErrorCode;

  constructor(code: SanitizedErrorCode) {
    super(code);
    this.name = "OAuthCallbackError";
    this.code = code;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function exactAppOrigin(env: (name: string) => string): string {
  const configured = env("APP_ORIGIN");
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute origin");
  }
  if (parsed.origin !== configured || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_ORIGIN must contain only scheme, host, and optional port");
  }
  return configured;
}

function appRedirect(appOrigin: string, code?: SanitizedErrorCode): Response {
  const suffix = code === undefined
    ? "/?google=connected"
    : `/?google=error&code=${SANITIZED_ERROR_CODES.has(code) ? code : "connection_failed"}`;
  return Response.redirect(`${appOrigin}${suffix}`, 303);
}

function parseFlowContext(serialized: string): FlowContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new OAuthCallbackError("invalid_state");
  }
  const context = parsed as Record<string, unknown>;
  if (
    context?.version !== 1 ||
    typeof context.personId !== "string" ||
    typeof context.pkceVerifier !== "string" ||
    context.pkceVerifier.length < 43 ||
    context.pkceVerifier.length > 128
  ) {
    throw new OAuthCallbackError("invalid_state");
  }
  return { personId: context.personId, pkceVerifier: context.pkceVerifier };
}

async function consumeFlow(
  database: SupabaseClient,
  state: string,
  now: Date,
): Promise<{ flow: ConsumedFlow; context: FlowContext }> {
  const stateHash = await sha256(state);
  const consumedAt = now.toISOString();
  const { data, error } = await database
    .from("google_oauth_flows")
    .update({ consumed_at: consumedAt })
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", consumedAt)
    .select("user_id,household_id,redirect_path");

  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new OAuthCallbackError("invalid_state");
  }
  const flow = data[0] as ConsumedFlow;
  return { flow, context: parseFlowContext(flow.redirect_path) };
}

async function exchangeCode(
  code: string,
  pkceVerifier: string,
  fetchImplementation: FetchImplementation,
  env: (name: string) => string,
): Promise<GoogleTokens> {
  let response: Response;
  try {
    const redirectUri = env("GOOGLE_OAUTH_REDIRECT_URI");
    response = await fetchImplementation(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_CLIENT_ID"),
        client_secret: env("GOOGLE_CLIENT_SECRET"),
        code,
        code_verifier: pkceVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
  } catch {
    throw new OAuthCallbackError("token_exchange_failed");
  }

  if (!response.ok) throw new OAuthCallbackError("token_exchange_failed");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OAuthCallbackError("token_exchange_failed");
  }
  const tokens = body as Record<string, unknown>;
  if (
    typeof tokens.access_token !== "string" ||
    typeof tokens.refresh_token !== "string" ||
    typeof tokens.expires_in !== "number" ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in <= 0
  ) {
    throw new OAuthCallbackError("token_exchange_failed");
  }
  return tokens as unknown as GoogleTokens;
}

async function loadGoogleUser(
  accessToken: string,
  fetchImplementation: FetchImplementation,
): Promise<GoogleUserInfo> {
  let response: Response;
  try {
    response = await fetchImplementation(GOOGLE_USERINFO_ENDPOINT, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new OAuthCallbackError("account_lookup_failed");
  }
  if (!response.ok) throw new OAuthCallbackError("account_lookup_failed");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OAuthCallbackError("account_lookup_failed");
  }
  const userinfo = body as Record<string, unknown>;
  if (
    typeof userinfo.sub !== "string" ||
    userinfo.sub.length === 0 ||
    (userinfo.email !== undefined && typeof userinfo.email !== "string")
  ) {
    throw new OAuthCallbackError("account_lookup_failed");
  }
  const googleAccountId = userinfo.sub;
  return {
    sub: googleAccountId,
    email: typeof userinfo.email === "string" ? userinfo.email : null,
  };
}

async function saveConnection(
  database: SupabaseClient,
  flow: ConsumedFlow,
  context: FlowContext,
  tokens: GoogleTokens,
  userinfo: GoogleUserInfo,
  now: Date,
  env: (name: string) => string,
  encrypt: typeof encryptToken,
): Promise<void> {
  const encryptionKey = env("GOOGLE_TOKEN_ENCRYPTION_KEY");
  const [accessTokenEncrypted, refreshTokenEncrypted] = await Promise.all([
    encrypt(tokens.access_token, encryptionKey),
    encrypt(tokens.refresh_token, encryptionKey),
  ]);
  const tokenExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
  const { error } = await database.from("google_connections").upsert({
    user_id: flow.user_id,
    household_id: flow.household_id,
    person_id: context.personId,
    google_account_id: userinfo.sub,
    display_email: userinfo.email,
    access_token_encrypted: accessTokenEncrypted,
    refresh_token_encrypted: refreshTokenEncrypted,
    token_expires_at: tokenExpiresAt,
    connection_state: "active",
    last_error: null,
    updated_at: now.toISOString(),
    disconnected_at: null,
  }, { onConflict: "user_id,google_account_id" });
  if (error) throw new OAuthCallbackError("connection_failed");
}

export async function handleOAuthCallback(
  req: Request,
  dependencies: OAuthCallbackDependencies = {},
): Promise<Response> {
  const env = dependencies.env ?? requiredServerEnv;
  const appOrigin = exactAppOrigin(env);
  if (req.method !== "GET") return appRedirect(appOrigin, "invalid_request");

  try {
    const requestUrl = new URL(req.url);
    const state = requestUrl.searchParams.get("state");
    if (!state || state.length > 512) {
      throw new OAuthCallbackError("invalid_request");
    }

    const database = dependencies.database ?? createServiceClient();
    const fetchImplementation = dependencies.fetch ?? fetch;
    const now = dependencies.now?.() ?? new Date();
    const encrypt = dependencies.encrypt ?? encryptToken;
    const { flow, context } = await consumeFlow(database, state, now);
    if (requestUrl.searchParams.has("error")) {
      throw new OAuthCallbackError("authorization_denied");
    }
    const code = requestUrl.searchParams.get("code");
    if (!code || code.length > 4096) {
      throw new OAuthCallbackError("invalid_request");
    }
    const tokens = await exchangeCode(code, context.pkceVerifier, fetchImplementation, env);
    const userinfo = await loadGoogleUser(tokens.access_token, fetchImplementation);
    await saveConnection(database, flow, context, tokens, userinfo, now, env, encrypt);
    return appRedirect(appOrigin);
  } catch (error) {
    const code = error instanceof OAuthCallbackError ? error.code : "connection_failed";
    return appRedirect(appOrigin, code);
  }
}

if (typeof Deno !== "undefined") {
  Deno.serve(handleOAuthCallback);
}
