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
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
}

export interface PersistedTokens {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GoogleClientDependencies {
  fetch?: FetchImplementation;
  now?: () => Date;
  env?: (name: string) => string;
  persistTokens?: (connectionId: string, tokens: PersistedTokens) => Promise<void>;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class GoogleApiError extends Error {
  readonly category: GoogleErrorCategory;
  readonly status: number;

  constructor(category: GoogleErrorCategory, status: number, message = "Google API request failed") {
    super(message);
    this.name = "GoogleApiError";
    this.category = category;
    this.status = status;
  }
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

async function persistTokens(
  connectionId: string,
  tokens: PersistedTokens,
): Promise<void> {
  const { error } = await createServiceClient()
    .from("google_connections")
    .update(tokens)
    .eq("id", connectionId);
  if (error) throw new GoogleApiError("transient", 503, "Google credential update failed");
}

function requestWithAuthorization(request: Request, accessToken: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return new Request(request.clone(), { headers });
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
  const saveTokens = dependencies.persistTokens ?? persistTokens;
  const encryptionKey = env("GOOGLE_TOKEN_ENCRYPTION_KEY");
  const originalRequest = request instanceof Request ? request.clone() : new Request(request);
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
      await saveTokens(connection.id, tokens);
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
    throw new GoogleApiError(classifyGoogleStatus(response.status), response.status);
  }
  return response;
}
