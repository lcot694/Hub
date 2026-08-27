import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shared = (name) => new URL(`../supabase/functions/_shared/${name}`, import.meta.url);

async function source(name) {
  return readFile(shared(name), "utf8");
}

test("Edge foundations keep privileged configuration in server-only modules", async () => {
  const files = ["auth.ts", "crypto.ts", "db.ts", "http.ts", "google-client.ts"];
  const sources = await Promise.all(files.map(source));

  assert.match(sources.join("\n"), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(sources.join("\n"), /GOOGLE_TOKEN_ENCRYPTION_KEY/);
});

test("browser source never contains server secret names", async () => {
  for (const path of ["app.js", "config.js", "lib/google-ui.js"]) {
    const browserSource = await readFile(new URL(`../${path}`, import.meta.url), "utf8").catch(() => "");
    assert.doesNotMatch(
      browserSource,
      /GOOGLE_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY|GOOGLE_TOKEN_ENCRYPTION_KEY|SYNC_CRON_SECRET/
    );
  }
});

test("authentication derives the user from a validated bearer token", async () => {
  const auth = await source("auth.ts");

  assert.match(auth, /authorization/i);
  assert.match(auth, /Bearer/);
  assert.match(auth, /auth\.getUser\s*\(\s*accessToken\s*\)/);
  assert.match(auth, /userId:\s*user\.id/);
  assert.doesNotMatch(auth, /body\s*\.\s*userId|json\s*\(\s*\).*userId/i);
});

test("token encryption uses a versioned AES-GCM envelope and validates the deployment key", async () => {
  const cryptoSource = await source("crypto.ts");

  assert.match(cryptoSource, /crypto\.subtle/);
  assert.match(cryptoSource, /AES-GCM/g);
  assert.match(cryptoSource, /new Uint8Array\(12\)/);
  assert.match(cryptoSource, /getRandomValues/);
  assert.match(cryptoSource, /keyBytes\.byteLength\s*!==\s*32/);
  assert.match(cryptoSource, /ENVELOPE_VERSION/);
  assert.match(cryptoSource, /decodeStoredEnvelope/);
  assert.match(cryptoSource, /startsWith\(\s*["']\\\\x["']\s*\)/);
});

test("HTTP helpers allow only the exact configured app origin", async () => {
  const http = await source("http.ts");

  assert.match(http, /APP_ORIGIN/);
  assert.match(http, /origin\s*!==\s*appOrigin/);
  assert.match(http, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(http, /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/);
});

test("Google client classifies relevant response statuses", async () => {
  const google = await source("google-client.ts");

  for (const status of [401, 403, 404, 409, 429, 500]) {
    assert.match(google, new RegExp(`(?:case\\s+${status}|status\\s*===\\s*${status}|status\\s*>=\\s*${status})`));
  }
  for (const category of ["authorization", "permission", "validation", "rate_limit", "transient", "permanent"]) {
    assert.match(google, new RegExp(`["']${category}["']`));
  }
});

test("Google token refresh is bounded, encrypted, persisted, and sanitized", async () => {
  const google = await source("google-client.ts");

  assert.match(google, /refreshAttempted/);
  assert.match(google, /encryptToken/);
  assert.match(google, /persistTokens/);
  assert.match(google, /Google API request failed/);
  assert.doesNotMatch(google, /throw new Error\([^\n]*(?:accessToken|refreshToken|responseBody)/);
  assert.doesNotMatch(google, /console\.(?:log|error|warn)/);
});

test("Google network failures become sanitized transient errors", async () => {
  const google = await source("google-client.ts");

  assert.match(google, /async function fetchSafely/);
  assert.match(google, /Google request could not be completed/);
  assert.match(google, /new GoogleApiError\("transient", 503/);
});
