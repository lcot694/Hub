import { decryptToken, encryptToken } from "./crypto.ts";
import { createServiceClient, requiredServerEnv } from "./db.ts";

export type GoogleErrorCategory =
  | "authorization"
  | "permission"
  | "validation"
  | "rate_limit"
  | "transient"
  | "permanent";

export interface GoogleConnection {
  id: string;
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  google_account_id: string;
  oauth_generation: number;
  connection_state: "active" | "reconnect_required" | "disconnected";
}

export interface PersistedTokens {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const ALLOWED_GOOGLE_API_HOSTS = new Set([
  "www.googleapis.com",
  "calendar.googleapis.com",
]);

export interface GoogleClientDependencies {
  fetch?: FetchImplementation;
  now?: () => Date;
  env?: (name: string) => string;
  database?: TokenPersistenceDatabase;
  persistTokens?: (owner: GoogleConnectionOwner, tokens: PersistedTokens) => Promise<void>;
}

export type GoogleConnectionOwner = Pick<GoogleConnection, "id" | "user_id" | "google_account_id" | "oauth_generation" | "connection_state">;

interface TokenPersistenceResult {
  data: Array<{ id: string }> | null;
  error: unknown;
}

interface TokenPersistenceQuery {
  update(values: PersistedTokens): TokenPersistenceQuery;
  eq(column: string, value: string | number): TokenPersistenceQuery;
  select(columns: string): PromiseLike<TokenPersistenceResult>;
}

export interface TokenPersistenceDatabase {
  from?(table: string): TokenPersistenceQuery;
  rpc?(name: string, parameters: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class GoogleApiError extends Error {
  readonly category: GoogleErrorCategory;
  readonly status: number;
  readonly reason?: string;

  constructor(
    category: GoogleErrorCategory,
    status: number,
    message = "Google API request failed",
    reason?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
    this.category = category;
    this.status = status;
    this.reason = reason;
  }
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

async function googleResponseError(response: Response): Promise<GoogleApiError> {
  let reason: string | undefined;
  if (response.status === 403) {
    try {
      const body = await response.clone().json() as { error?: { errors?: Array<{ reason?: unknown }> } };
      const candidate = body?.error?.errors?.[0]?.reason;
      if (typeof candidate === "string" && RATE_LIMIT_REASONS.has(candidate)) reason = candidate;
    } catch {
      // A malformed error body remains a normal sanitized permission failure.
    }
  }
  return new GoogleApiError(
    reason ? "rate_limit" : classifyGoogleStatus(response.status),
    response.status,
    "Google API request failed",
    reason,
  );
}

export function classifyGoogleStatus(status: number): GoogleErrorCategory {
  if (status === 401) return "authorization";
  if (status === 403) return "permission";
  if (status === 404) return "permanent";
  if (status === 409) return "validation";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  if (status >= 400 && status < 500) return "validation";
  return "permanent";
}

export async function persistConnectionTokens(
  owner: GoogleConnectionOwner,
  tokens: PersistedTokens,
  database: TokenPersistenceDatabase = createServiceClient() as unknown as TokenPersistenceDatabase,
): Promise<void> {
  if (!owner.id || !owner.user_id || !owner.google_account_id || !Number.isInteger(owner.oauth_generation) || owner.connection_state !== "active") {
    throw new GoogleApiError("transient", 503, "Google credential update failed");
  }

  if (database.rpc) {
    const { data, error } = await database.rpc("persist_google_refreshed_tokens", {
      p_connection_id: owner.id,
      p_user_id: owner.user_id,
      p_google_account_id: owner.google_account_id,
      p_oauth_generation: owner.oauth_generation,
      p_access_token_encrypted: tokens.access_token_encrypted,
      p_refresh_token_encrypted: tokens.refresh_token_encrypted,
      p_token_expires_at: tokens.token_expires_at,
    });
    if (error || data !== true) throw new GoogleApiError("transient", 503, "Google credential update failed");
    return;
  }
  if (!database.from) throw new GoogleApiError("transient", 503, "Google credential update failed");
  const { data, error } = await database.from("google_connections")
    .update(tokens)
    .eq("id", owner.id)
    .eq("user_id", owner.user_id)
    .eq("google_account_id", owner.google_account_id)
    .eq("oauth_generation", owner.oauth_generation)
    .eq("connection_state", "active")
    .select("id");
  if (
    error ||
    !Array.isArray(data) ||
    data.length !== 1 ||
    data[0]?.id !== owner.id
  ) {
    throw new GoogleApiError("transient", 503, "Google credential update failed");
  }
}

function requestWithAuthorization(request: Request, accessToken: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return new Request(request.clone(), { headers });
}

function requireGoogleApiDestination(request: Request): Request {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !ALLOWED_GOOGLE_API_HOSTS.has(url.hostname)
  ) {
    throw new GoogleApiError("validation", 400, "Google API destination is not allowed");
  }
  return new Request(request.clone(), { redirect: "error" });
}

async function fetchSafely(
  fetchImplementation: FetchImplementation,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImplementation(input, init);
  } catch {
    throw new GoogleApiError("transient", 503, "Google request could not be completed");
  }
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now.getTime();
}

export async function googleFetch(
  connection: GoogleConnection,
  request: Request | string | URL,
  dependencies: GoogleClientDependencies = {},
): Promise<Response> {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const env = dependencies.env ?? requiredServerEnv;
  const saveTokens = dependencies.persistTokens ?? ((
    owner: GoogleConnectionOwner,
    tokens: PersistedTokens,
  ) => (
    persistConnectionTokens(owner, tokens, dependencies.database)
  ));
  const originalRequest = requireGoogleApiDestination(
    request instanceof Request ? request.clone() : new Request(request),
  );
  const encryptionKey = env("GOOGLE_TOKEN_ENCRYPTION_KEY");
  let accessToken = await decryptToken(connection.access_token_encrypted, encryptionKey);
  let refreshAttempted = false;

  const refreshAccessToken = async (): Promise<string> => {
    if (refreshAttempted || !connection.refresh_token_encrypted) {
      throw new GoogleApiError("authorization", 401, "Google authorization needs reconnecting");
    }
    refreshAttempted = true;

    const refreshToken = await decryptToken(connection.refresh_token_encrypted, encryptionKey);
    const response = await fetchSafely(fetchImplementation, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_CLIENT_ID"),
        client_secret: env("GOOGLE_CLIENT_SECRET"),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const category = response.status >= 500
        ? "transient"
        : response.status === 429
        ? "rate_limit"
        : "authorization";
      throw new GoogleApiError(category, response.status, "Google authorization refresh failed");
    }

    let body: GoogleTokenResponse;
    try {
      body = await response.json() as GoogleTokenResponse;
    } catch {
      throw new GoogleApiError("authorization", 401, "Google authorization refresh failed");
    }

    if (
      typeof body.access_token !== "string" ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      (body.refresh_token !== undefined && typeof body.refresh_token !== "string")
    ) {
      throw new GoogleApiError("authorization", 401, "Google authorization refresh failed");
    }

    const nextRefreshToken = typeof body.refresh_token === "string" ? body.refresh_token : refreshToken;
    const tokens: PersistedTokens = {
      access_token_encrypted: await encryptToken(body.access_token, encryptionKey),
      refresh_token_encrypted: await encryptToken(nextRefreshToken, encryptionKey),
      token_expires_at: new Date(now().getTime() + body.expires_in * 1000).toISOString(),
    };

    try {
      await saveTokens({
        id: connection.id,
        user_id: connection.user_id,
        google_account_id: connection.google_account_id,
        oauth_generation: connection.oauth_generation,
        connection_state: connection.connection_state,
      }, tokens);
    } catch {
      throw new GoogleApiError("transient", 503, "Google credential update failed");
    }

    connection.access_token_encrypted = tokens.access_token_encrypted;
    connection.refresh_token_encrypted = tokens.refresh_token_encrypted;
    connection.token_expires_at = tokens.token_expires_at;
    return body.access_token;
  };

  if (isExpired(connection.token_expires_at, now())) {
    accessToken = await refreshAccessToken();
  }

  let response = await fetchSafely(
    fetchImplementation,
    requestWithAuthorization(originalRequest, accessToken),
  );
  if (response.status === 401 && !refreshAttempted) {
    accessToken = await refreshAccessToken();
    response = await fetchSafely(
      fetchImplementation,
      requestWithAuthorization(originalRequest, accessToken),
    );
  }

  if (!response.ok) {
    throw await googleResponseError(response);
  }
  return response;
}
