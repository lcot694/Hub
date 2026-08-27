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

const handler = (name) => new URL(`../supabase/functions/${name}/index.ts`, import.meta.url);

async function source(name) {
  return readFile(handler(name), "utf8");
}

const oauthStart = import("../supabase/functions/google-oauth-start/index.ts");
const oauthCallback = import("../supabase/functions/google-oauth-callback/index.ts");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_HOUSEHOLD_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_PERSON_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-27T12:00:00.000Z");
const APP_ORIGIN = "https://family.example";
const REDIRECT_URI = "https://project.supabase.co/functions/v1/google-oauth-callback";

function testEnv(name) {
  return {
    APP_ORIGIN,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
    GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  }[name];
}

async function withDenoEnv(run) {
  const previous = globalThis.Deno;
  globalThis.Deno = { env: { get: testEnv } };
  try {
    return await run();
  } finally {
    if (previous === undefined) delete globalThis.Deno;
    else globalThis.Deno = previous;
  }
}

function startDatabase({ membership = true, person = true, flowError = null } = {}) {
  const insertedFlows = [];
  return {
    insertedFlows,
    from(table) {
      if (table === "household_members" || table === "people") {
        const found = table === "household_members" ? membership : person;
        const query = {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: found ? { id: "found" } : null, error: null });
          },
        };
        return query;
      }
      if (table === "google_oauth_flows") {
        return {
          insert(values) {
            insertedFlows.push(values);
            return Promise.resolve({ error: flowError });
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function callbackDatabase({
  flowRows = [{
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    redirect_path: JSON.stringify({ version: 1, personId: PERSON_ID, pkceVerifier: "v".repeat(43) }),
  }],
  membership = true,
  person = true,
  existing = null,
} = {}) {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    from(table) {
      calls.push(["from", table]);
      if (table === "google_oauth_flows") {
        return {
          update(values) { calls.push(["flow-update", values]); return this; },
          eq(column, value) { calls.push(["flow-eq", column, value]); return this; },
          is(column, value) { calls.push(["flow-is", column, value]); return this; },
          gt(column, value) { calls.push(["flow-gt", column, value]); return this; },
          select(columns) {
            calls.push(["flow-select", columns]);
            return Promise.resolve({ data: flowRows, error: null });
          },
        };
      }
      if (table === "household_members" || table === "people") {
        const found = table === "household_members" ? membership : person;
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: found ? { id: "found" } : null, error: null });
          },
        };
      }
      if (table === "google_connections") {
        let operation = "select";
        let values;
        return {
          select() { if (operation !== "update") operation = "select"; return this; },
          update(nextValues) { operation = "update"; values = nextValues; return this; },
          insert(nextValues) {
            writes.push({ operation: "insert", values: nextValues });
            return Promise.resolve({ data: [{ id: "new-connection" }], error: null });
          },
          upsert(nextValues) {
            writes.push({ operation: "upsert", values: nextValues });
            return Promise.resolve({ error: null });
          },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: existing, error: null });
          },
          then(resolve) {
            if (operation === "update") {
              writes.push({ operation, values });
              resolve({ data: [{ id: existing?.id }], error: null });
            }
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function googleFetch({ refreshToken = "new-refresh", includeRefreshToken = true, accountId = "google-account" } = {}) {
  const requests = [];
  const implementation = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input) === "https://oauth2.googleapis.com/token") {
      const body = { access_token: "new-access", expires_in: 3600 };
      if (includeRefreshToken) body.refresh_token = refreshToken;
      return Response.json(body);
    }
    if (String(input) === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({ sub: accountId, email: "adult@example.com" });
    }
    throw new Error(`Unexpected fetch: ${input}`);
  };
  return { implementation, requests };
}

function callbackRequest(search = "?code=code-1&state=state-1") {
  return new Request(`https://project.supabase.co/functions/v1/google-oauth-callback${search}`);
}

function callbackDependencies(database, fetchImplementation, overrides = {}) {
  return {
    database,
    fetch: fetchImplementation,
    env: testEnv,
    now: () => NOW,
    encrypt: async (value) => `encrypted:${value}`,
    ...overrides,
  };
}

test("Supabase serves the OAuth callback publicly while OAuth start stays JWT verified", async () => {
  const config = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(config, /\[functions\.google-oauth-callback\][\s\S]*?verify_jwt\s*=\s*false/);
  assert.doesNotMatch(config, /\[functions\.google-oauth-start\][\s\S]*?verify_jwt\s*=\s*false/);
});

test("OAuth start returns the exact authorization contract and ten-minute expiry", async () => {
  const { handleOAuthStart } = await oauthStart;
  const database = startDatabase();
  const response = await withDenoEnv(() => handleOAuthStart(new Request(
    "https://project.supabase.co/functions/v1/google-oauth-start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
      body: JSON.stringify({ householdId: HOUSEHOLD_ID, personId: PERSON_ID }),
    },
  ), {
    authenticate: async () => ({ userId: USER_ID, accessToken: "jwt" }),
    database,
    env: testEnv,
    now: () => NOW,
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), APP_ORIGIN);
  assert.equal(database.insertedFlows.length, 1);
  assert.equal(database.insertedFlows[0].expires_at, "2026-08-27T12:10:00.000Z");
  assert.notEqual(database.insertedFlows[0].state_hash, "");
  const authorizationUrl = new URL((await response.json()).authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.pathname, "/o/oauth2/v2/auth");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(authorizationUrl.searchParams.get("scope").split(" "), [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ]);
});

test("OAuth start preserves allowed-origin CORS headers on every sanitized error", async (t) => {
  const { HttpError } = await import("../supabase/functions/_shared/http.ts");
  const { handleOAuthStart } = await oauthStart;
  const cases = [
    { name: "bad input", method: "POST", authenticate: async () => ({ userId: USER_ID }), body: {}, database: startDatabase(), status: 400 },
    { name: "unauthorized", method: "POST", authenticate: async () => { throw new HttpError(401, "unauthorized", "no"); }, body: { householdId: HOUSEHOLD_ID, personId: PERSON_ID }, database: startDatabase(), status: 401 },
    { name: "revoked household", method: "POST", authenticate: async () => ({ userId: USER_ID }), body: { householdId: HOUSEHOLD_ID, personId: PERSON_ID }, database: startDatabase({ membership: false }), status: 403 },
    { name: "wrong method", method: "GET", authenticate: async () => ({ userId: USER_ID }), database: startDatabase(), status: 405 },
  ];

  for (const item of cases) await t.test(item.name, async () => {
    const init = { method: item.method, headers: { Origin: APP_ORIGIN } };
    if (item.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(item.body);
    }
    const response = await withDenoEnv(() => handleOAuthStart(
      new Request("https://project.supabase.co/functions/v1/google-oauth-start", init),
      { authenticate: item.authenticate, database: item.database, env: testEnv, now: () => NOW },
    ));
    assert.equal(response.status, item.status);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), APP_ORIGIN);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
  });
});

test("OAuth callback rejects a consumed or expired state without contacting Google", async () => {
  const { handleOAuthCallback } = await oauthCallback;
  const database = callbackDatabase({ flowRows: [] });
  const google = googleFetch();
  const response = await handleOAuthCallback(
    callbackRequest(),
    callbackDependencies(database, google.implementation),
  );

  assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=error&code=invalid_state`);
  assert.equal(google.requests.length, 0);
});

test("OAuth callback revalidates household membership before contacting Google", async () => {
  const { handleOAuthCallback } = await oauthCallback;
  const database = callbackDatabase({ membership: false });
  const google = googleFetch();
  const response = await handleOAuthCallback(
    callbackRequest(),
    callbackDependencies(database, google.implementation),
  );

  assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=error&code=authorization_revoked`);
  assert.equal(google.requests.length, 0);
  assert.equal(database.writes.length, 0);
});

test("OAuth callback rejects a selected person removed from the household", async () => {
  const { handleOAuthCallback } = await oauthCallback;
  const database = callbackDatabase({ person: false });
  const google = googleFetch();
  const response = await handleOAuthCallback(
    callbackRequest(),
    callbackDependencies(database, google.implementation),
  );

  assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=error&code=authorization_revoked`);
  assert.equal(google.requests.length, 0);
  assert.equal(database.writes.length, 0);
});

test("OAuth reconnect rejects a different household or person without updating sync state", async (t) => {
  const { handleOAuthCallback } = await oauthCallback;
  for (const mismatch of [
    { name: "household", household_id: OTHER_HOUSEHOLD_ID, person_id: PERSON_ID },
    { name: "person", household_id: HOUSEHOLD_ID, person_id: OTHER_PERSON_ID },
  ]) await t.test(mismatch.name, async () => {
    const existing = {
      id: "connection-1",
      user_id: USER_ID,
      household_id: mismatch.household_id,
      person_id: mismatch.person_id,
      google_account_id: "google-account",
      refresh_token_encrypted: "encrypted:old-refresh",
    };
    const database = callbackDatabase({ existing });
    const google = googleFetch();
    const response = await handleOAuthCallback(
      callbackRequest(),
      callbackDependencies(database, google.implementation),
    );

    assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=error&code=context_mismatch`);
    assert.equal(database.writes.length, 0);
  });
});

test("OAuth reconnect preserves the encrypted refresh token when Google omits rotation", async () => {
  const { handleOAuthCallback } = await oauthCallback;
  const existing = {
    id: "connection-1",
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    person_id: PERSON_ID,
    google_account_id: "google-account",
    refresh_token_encrypted: "encrypted:old-refresh",
  };
  const database = callbackDatabase({ existing });
  const google = googleFetch({ includeRefreshToken: false });
  const response = await handleOAuthCallback(
    callbackRequest(),
    callbackDependencies(database, google.implementation),
  );

  assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=connected`);
  assert.equal(database.writes.length, 1);
  assert.equal(database.writes[0].operation, "update");
  assert.equal(database.writes[0].values.refresh_token_encrypted, "encrypted:old-refresh");
  assert.equal(database.writes[0].values.household_id, undefined);
  assert.equal(database.writes[0].values.person_id, undefined);
});

test("OAuth callback rejects switching to another Google account for the same adult", async () => {
  const { handleOAuthCallback } = await oauthCallback;
  const existing = {
    id: "connection-1", user_id: USER_ID, household_id: HOUSEHOLD_ID, person_id: PERSON_ID,
    google_account_id: "first-google-account", refresh_token_encrypted: "encrypted:old-refresh",
  };
  const database = callbackDatabase({ existing });
  const google = googleFetch({ accountId: "second-google-account" });

  const response = await handleOAuthCallback(callbackRequest(), callbackDependencies(database, google.implementation));

  assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=error&code=account_switch_requires_disconnect`);
  assert.equal(database.writes.length, 0);
});

test("OAuth first connection requires a Google refresh token", async () => {
  const { handleOAuthCallback } = await oauthCallback;
  const database = callbackDatabase({ existing: null });
  const google = googleFetch({ includeRefreshToken: false });
  const response = await handleOAuthCallback(
    callbackRequest(),
    callbackDependencies(database, google.implementation),
  );

  assert.equal(response.headers.get("Location"), `${APP_ORIGIN}/?google=error&code=refresh_token_required`);
  assert.equal(database.writes.length, 0);
});

test("OAuth start authenticates and verifies the selected household and person", async () => {
  const start = await source("google-oauth-start");

  assert.match(start, /authenticate\s*=\s*dependencies\.authenticate\s*\?\?\s*requireUser/);
  assert.match(start, /from\(\s*["']household_members["']\s*\)/);
  assert.match(start, /eq\(\s*["']user_id["']\s*,\s*userId\s*\)/);
  assert.match(start, /from\(\s*["']people["']\s*\)/);
  assert.match(start, /eq\(\s*["']household_id["']\s*,\s*householdId\s*\)/);
  assert.match(start, /eq\(\s*["']id["']\s*,\s*personId\s*\)/);
});

test("OAuth start uses random hashed state, PKCE S256, and a ten-minute flow", async () => {
  const start = await source("google-oauth-start");

  assert.match(start, /crypto\.getRandomValues/);
  assert.match(start, /crypto\.subtle\.digest\(\s*["']SHA-256["']/);
  assert.match(start, /state_hash:\s*stateHash/);
  assert.match(start, /pkceVerifier/);
  assert.match(start, /10\s*\*\s*60\s*\*\s*1000/);
  assert.match(start, /code_challenge_method["']?\s*,\s*["']S256["']/);
  assert.doesNotMatch(start, /state_hash:\s*state(?:\s*[,}])/);
});

test("OAuth authorization request uses the configured callback and required consent contract", async () => {
  const start = await source("google-oauth-start");

  for (const scope of [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ]) assert.match(start, new RegExp(scope.replace(/[./]/g, "\\$&")));

  assert.match(start, /GOOGLE_OAUTH_REDIRECT_URI/);
  assert.match(start, /redirect_uri["']?\s*,\s*redirectUri/);
  assert.match(start, /access_type["']?\s*,\s*["']offline["']/);
  assert.match(start, /prompt["']?\s*,\s*["']consent["']/);
});

test("OAuth callback atomically consumes only a matching unexpired unused state", async () => {
  const callback = await source("google-oauth-callback");

  assert.match(callback, /stateHash\s*=\s*await sha256/);
  assert.match(callback, /from\(\s*["']google_oauth_flows["']\s*\)/);
  assert.match(callback, /update\(\s*\{\s*consumed_at:/);
  assert.match(callback, /eq\(\s*["']state_hash["']\s*,\s*stateHash\s*\)/);
  assert.match(callback, /is\(\s*["']consumed_at["']\s*,\s*null\s*\)/);
  assert.match(callback, /gt\(\s*["']expires_at["']/);
  assert.match(callback, /code_verifier["']?\s*:\s*pkceVerifier/);
});

test("OAuth callback consumes valid state before handling a Google denial", async () => {
  const callback = await source("google-oauth-callback");
  const handlerBody = callback.slice(callback.indexOf("export async function handleOAuthCallback"));

  assert.ok(handlerBody.indexOf("await consumeFlow") >= 0);
  assert.ok(handlerBody.indexOf('searchParams.has("error")') >= 0);
  assert.ok(handlerBody.indexOf("await consumeFlow") < handlerBody.indexOf('searchParams.has("error")'));
});

test("OAuth callback encrypts credentials and persists the stable Google account identity", async () => {
  const callback = await source("google-oauth-callback");

  assert.match(callback, /https:\/\/openidconnect\.googleapis\.com\/v1\/userinfo/);
  assert.match(callback, /googleAccountId\s*=\s*userinfo\.sub/);
  assert.match(callback, /encrypt\(\s*tokens\.access_token/);
  assert.match(callback, /encrypt\(\s*tokens\.refresh_token/);
  assert.match(callback, /dependencies\.encrypt\s*\?\?\s*encryptToken/);
  assert.match(callback, /from\(\s*["']google_connections["']\s*\)/);
  assert.match(callback, /from\(\s*["']google_connections["']\s*\)\.insert/);
  assert.match(callback, /from\(\s*["']google_connections["']\s*\)\.update/);
  assert.doesNotMatch(callback, /\.upsert\(/);
  assert.doesNotMatch(callback, /access_token:\s*tokens\.access_token/);
  assert.doesNotMatch(callback, /refresh_token:\s*tokens\.refresh_token/);
});

test("OAuth callback redirects only to fixed app paths with sanitized error codes", async () => {
  const callback = await source("google-oauth-callback");

  assert.match(callback, /APP_ORIGIN/);
  assert.match(callback, /google=connected/);
  assert.match(callback, /google=error&code=/);
  assert.match(callback, /SANITIZED_ERROR_CODES/);
  assert.doesNotMatch(callback, /searchParams\.set\(\s*["'](?:access_token|refresh_token|token|jwt)["']/i);
  assert.doesNotMatch(callback, /new URL\(\s*flow\.redirect_path|Location[^\n]*redirect_path/);
});
