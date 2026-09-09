import { requiredServerEnv } from "./db.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function json(
  status: number,
  body: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function configuredAppOrigin(): string {
  const appOrigin = requiredServerEnv("APP_ORIGIN");
  let parsed: URL;
  try {
    parsed = new URL(appOrigin);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute origin");
  }

  if (parsed.origin !== appOrigin || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_ORIGIN must contain only scheme, host, and optional port");
  }
  return appOrigin;
}

export function corsHeaders(req: Request): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = req.headers.get("Origin");
  if (origin === null) return headers;

  const appOrigin = configuredAppOrigin();
  if (origin !== appOrigin) {
    throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
  }

  headers.set("Access-Control-Allow-Origin", appOrigin);
  headers.set("Access-Control-Allow-Headers", "authorization, content-type, x-client-info, apikey");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  return headers;
}

export function handleCors(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;

  try {
    const headers = corsHeaders(req);
    if (!headers.has("Access-Control-Allow-Origin")) {
      return json(403, { error: "origin_not_allowed" }, headers);
    }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.code }, { Vary: "Origin" });
    }
    throw error;
  }
}
