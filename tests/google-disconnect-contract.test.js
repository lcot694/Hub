import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("npm:")) return {
      shortCircuit: true,
      url: "data:text/javascript,export function createClient(){throw new Error('Unexpected database access')}",
    };
    return nextResolve(specifier, context);
  },
});

const disconnectApi = import("../supabase/functions/google-disconnect/index.ts");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION = {
  id: "connection-1", user_id: USER_ID, household_id: "household-1",
  access_token_encrypted: "encrypted-access", refresh_token_encrypted: "encrypted-refresh",
};

function request(body, method = "POST") {
  return new Request("https://project.test/google-disconnect", {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("only the authenticated connection owner can disconnect", async () => {
  const { createGoogleDisconnectHandler } = await disconnectApi;
  let cleaned = false;
  const handler = createGoogleDisconnectHandler({
    authenticate: async () => ({ userId: USER_ID }),
    store: {
      loadOwnedConnection: async () => null,
      disconnect: async () => { cleaned = true; },
    },
    revokeToken: async () => { throw new Error("must not revoke an unowned token"); },
  });

  const response = await handler(request({ mode: "keep_local" }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "connection_not_found" });
  assert.equal(cleaned, false);
});

test("keep_local revokes best-effort then transactionally detaches only the owner's connection", async () => {
  const { createGoogleDisconnectHandler } = await disconnectApi;
  const calls = [];
  const handler = createGoogleDisconnectHandler({
    authenticate: async () => ({ userId: USER_ID }),
    store: {
      loadOwnedConnection: async (userId) => { calls.push(["load", userId]); return CONNECTION; },
      disconnect: async (...args) => { calls.push(["disconnect", ...args]); },
    },
    revokeToken: async (connection) => { calls.push(["revoke", connection.id]); },
  });

  const response = await handler(request({ mode: "keep_local" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { disconnected: true, mode: "keep_local" });
  assert.deepEqual(calls, [
    ["load", USER_ID],
    ["revoke", CONNECTION.id],
    ["disconnect", CONNECTION.id, USER_ID, "keep_local"],
  ]);
});

test("remove_local completes credential erasure when Google revocation is unavailable", async () => {
  const { createGoogleDisconnectHandler } = await disconnectApi;
  const calls = [];
  const handler = createGoogleDisconnectHandler({
    authenticate: async () => ({ userId: USER_ID }),
    store: {
      loadOwnedConnection: async () => CONNECTION,
      disconnect: async (...args) => { calls.push(args); },
    },
    revokeToken: async () => { throw new Error("network and token details stay private"); },
  });

  const response = await handler(request({ mode: "remove_local" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { disconnected: true, mode: "remove_local" });
  assert.deepEqual(calls, [[CONNECTION.id, USER_ID, "remove_local"]]);
});

test("invalid methods and modes are rejected before credentials or data are touched", async () => {
  const { createGoogleDisconnectHandler } = await disconnectApi;
  let touched = false;
  const handler = createGoogleDisconnectHandler({
    authenticate: async () => ({ userId: USER_ID }),
    store: {
      loadOwnedConnection: async () => { touched = true; return CONNECTION; },
      disconnect: async () => { touched = true; },
    },
    revokeToken: async () => { touched = true; },
  });

  for (const candidate of [{ mode: "delete_everywhere" }, {}, { mode: null }]) {
    const response = await handler(request(candidate));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  const method = await handler(request(undefined, "GET"));
  assert.equal(method.status, 405);
  assert.equal(touched, false);
});

test("the production revoker can only call Google's token revocation endpoint", async () => {
  const { revokeGoogleToken } = await disconnectApi;
  const calls = [];
  await revokeGoogleToken(CONNECTION, {
    decrypt: async (encrypted) => encrypted === "encrypted-refresh" ? "refresh-token" : "access-token",
    env: () => "encryption-key",
    fetch: async (input, init) => {
      calls.push([String(input), init]);
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://oauth2.googleapis.com/revoke");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(String(calls[0][1].body), "token=refresh-token");
  assert.doesNotMatch(calls[0][0], /calendar\/v3|events/i);
});

test("database store invokes one owner-scoped disconnect transaction", async () => {
  const { createDisconnectStore } = await disconnectApi;
  const calls = [];
  const database = {
    from(table) {
      assert.equal(table, "google_connections");
      return {
        select(columns) { calls.push(["select", columns]); return this; },
        eq(column, value) { calls.push(["eq", column, value]); return this; },
        maybeSingle: async () => ({ data: CONNECTION, error: null }),
      };
    },
    rpc: async (name, args) => { calls.push(["rpc", name, args]); return { data: true, error: null }; },
  };
  const store = createDisconnectStore(database);

  assert.equal(await store.loadOwnedConnection(USER_ID), CONNECTION);
  await store.disconnect(CONNECTION.id, USER_ID, "remove_local");
  assert.deepEqual(calls.at(-1), ["rpc", "disconnect_google_calendar", {
    p_connection_id: CONNECTION.id, p_user_id: USER_ID, p_mode: "remove_local",
  }]);
});

test("disconnect cleanup migration scopes every destructive step and credential wipe to one owned connection", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608270006_google_disconnect.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer\s+set search_path = public/i);
  assert.match(sql, /c\.id = p_connection_id\s+and c\.user_id = p_user_id\s+for update/i);
  assert.match(sql, /m\.google_connection_id = p_connection_id/g);
  assert.match(sql, /if p_mode = 'remove_local'[\s\S]*delete from public\.events/i);
  assert.match(sql, /access_token_encrypted = null[\s\S]*refresh_token_encrypted = null[\s\S]*connection_state = 'disconnected'/i);
  assert.match(sql, /revoke all on function public\.disconnect_google_calendar\(uuid, uuid, text\)[\s\S]*grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /http|googleapis|google_event_id\s*=|delete_google/i);
});

test("keep_local makes a pending delete visible before detaching its Google mapping", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608270007_google_disconnect_race_hardening.sql", import.meta.url), "utf8");
  const clearPendingDelete = sql.indexOf("set sync_deleted_at = null");
  const deleteQueue = sql.indexOf("delete from public.google_sync_queue");
  const deleteMappings = sql.indexOf("delete from public.google_event_mappings");
  assert.ok(clearPendingDelete >= 0);
  assert.ok(clearPendingDelete < deleteQueue);
  assert.ok(deleteQueue < deleteMappings);
  assert.match(sql, /where e\.id = any\(v_event_ids\)/i);
});

test("disconnect invalidates pre-existing OAuth flows and advances the connection generation", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608270007_google_disconnect_race_hardening.sql", import.meta.url), "utf8");
  assert.match(sql, /update public\.google_oauth_flows[\s\S]*consumed_at = clock_timestamp\(\)[\s\S]*user_id = p_user_id[\s\S]*consumed_at is null/i);
  assert.match(sql, /oauth_generation = c\.oauth_generation \+ 1/i);
});

test("disconnect returns sanitized authenticated errors with exact-origin CORS", async () => {
  const { createGoogleDisconnectHandler } = await disconnectApi;
  const { HttpError } = await import("../supabase/functions/_shared/http.ts");
  const previous = globalThis.Deno;
  globalThis.Deno = { env: { get: (name) => name === "APP_ORIGIN" ? "https://family.example" : undefined } };
  try {
    const response = await createGoogleDisconnectHandler({
      authenticate: async () => { throw new HttpError(401, "unauthorized", "private auth detail"); },
    })(new Request("https://project.test/google-disconnect", {
      method: "POST", headers: { Origin: "https://family.example", "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "keep_local" }),
    }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://family.example");
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    if (previous === undefined) delete globalThis.Deno;
    else globalThis.Deno = previous;
  }
});
