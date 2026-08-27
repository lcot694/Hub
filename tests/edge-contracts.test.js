import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("npm:")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function createClient(){throw new Error('Unexpected live database access')}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const shared = (name) => new URL(`../supabase/functions/_shared/${name}`, import.meta.url);

async function source(name) {
  return readFile(shared(name), "utf8");
}

const googleClient = import("../supabase/functions/_shared/google-client.ts");
const tokenCrypto = import("../supabase/functions/_shared/crypto.ts");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

async function connection(overrides = {}) {
  const { encryptToken } = await tokenCrypto;
  return {
    id: "connection-1",
    user_id: "owner-1",
    access_token_encrypted: await encryptToken("old-access", TEST_KEY),
    refresh_token_encrypted: await encryptToken("old-refresh", TEST_KEY),
    token_expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function testEnvironment(name) {
  const values = {
    GOOGLE_TOKEN_ENCRYPTION_KEY: TEST_KEY,
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
  };
  return values[name];
}

function fakeTokenDatabase(rows, databaseError = null) {
  const calls = [];
  const query = {
    update(values) {
      calls.push(["update", values]);
      return this;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return this;
    },
    select(columns) {
      calls.push(["select", columns]);
      return Promise.resolve({ data: rows, error: databaseError });
    },
  };
  return {
    calls,
    database: {
      from(table) {
        calls.push(["from", table]);
        return query;
      },
    },
  };
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

test("bearer authentication is sent only to allowlisted HTTPS Google API hosts", async () => {
  const { googleFetch } = await googleClient;

  for (const url of [
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    "https://calendar.googleapis.com/calendar/v3/calendars/primary/events",
  ]) {
    const observed = [];
    const result = await googleFetch(await connection(), url, {
      env: testEnvironment,
      fetch: async (request) => {
        observed.push(request);
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(result.status, 204);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].headers.get("Authorization"), "Bearer old-access");
    assert.equal(observed[0].redirect, "error");
  }
});

test("non-HTTPS and non-Google destinations are rejected before fetch", async () => {
  const { GoogleApiError, googleFetch } = await googleClient;

  for (const url of [
    "http://www.googleapis.com/calendar/v3/calendars/primary/events",
    "https://attacker.example/collect",
    "https://www.googleapis.com.attacker.example/collect",
  ]) {
    let fetchCalls = 0;
    await assert.rejects(
      googleFetch(await connection(), url, {
        env: testEnvironment,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 204 });
        },
      }),
      (error) => error instanceof GoogleApiError && error.category === "validation" && error.status === 400,
    );
    assert.equal(fetchCalls, 0);
  }
});

test("credential persistence filters by connection and owner and requires one updated row", async () => {
  const { persistConnectionTokens } = await googleClient;
  assert.equal(typeof persistConnectionTokens, "function");
  const tokens = {
    access_token_encrypted: "encrypted-access",
    refresh_token_encrypted: "encrypted-refresh",
    token_expires_at: "2026-08-27T12:00:00.000Z",
  };
  const fake = fakeTokenDatabase([{ id: "connection-1" }]);

  await persistConnectionTokens(
    { id: "connection-1", user_id: "owner-1" },
    tokens,
    fake.database,
  );

  assert.deepEqual(fake.calls, [
    ["from", "google_connections"],
    ["update", tokens],
    ["eq", "id", "connection-1"],
    ["eq", "user_id", "owner-1"],
    ["select", "id"],
  ]);
});

test("credential persistence safely rejects a zero-row owner-scoped update", async () => {
  const { GoogleApiError, persistConnectionTokens } = await googleClient;
  assert.equal(typeof persistConnectionTokens, "function");
  const fake = fakeTokenDatabase([]);

  await assert.rejects(
    persistConnectionTokens(
      { id: "connection-1", user_id: "wrong-owner" },
      {
        access_token_encrypted: "encrypted-access",
        refresh_token_encrypted: "encrypted-refresh",
        token_expires_at: "2026-08-27T12:00:00.000Z",
      },
      fake.database,
    ),
    (error) => (
      error instanceof GoogleApiError &&
      error.category === "transient" &&
      error.status === 503 &&
      !error.message.includes("connection-1") &&
      !error.message.includes("wrong-owner")
    ),
  );
});

test("a 401 refreshes once, persists rotated tokens for the owner, and retries once", async () => {
  const { GoogleApiError, googleFetch } = await googleClient;
  const { decryptToken } = await tokenCrypto;
  const requests = [];
  let persisted;
  const activeConnection = await connection();

  await assert.rejects(
    googleFetch(activeConnection, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      env: testEnvironment,
      persistTokens: async (owner, tokens) => {
        persisted = { owner, tokens };
      },
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({ input, init, url });
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          });
        }
        return new Response(null, { status: 401 });
      },
    }),
    (error) => error instanceof GoogleApiError && error.category === "authorization",
  );

  assert.equal(requests.filter(({ url }) => url === "https://oauth2.googleapis.com/token").length, 1);
  const calendarRequests = requests.filter(({ url }) => url !== "https://oauth2.googleapis.com/token");
  assert.equal(calendarRequests.length, 2);
  assert.equal(calendarRequests[0].input.headers.get("Authorization"), "Bearer old-access");
  assert.equal(calendarRequests[1].input.headers.get("Authorization"), "Bearer rotated-access");
  assert.equal(calendarRequests.every(({ input }) => input.redirect === "error"), true);
  assert.deepEqual(persisted.owner, { id: "connection-1", user_id: "owner-1" });
  assert.equal(await decryptToken(persisted.tokens.access_token_encrypted, TEST_KEY), "rotated-access");
  assert.equal(await decryptToken(persisted.tokens.refresh_token_encrypted, TEST_KEY), "rotated-refresh");
});
