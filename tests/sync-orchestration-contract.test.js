import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("npm:")) return {
      shortCircuit: true,
      url: "data:text/javascript,export function createClient(){throw new Error('Unexpected live database access')}",
    };
    return nextResolve(specifier, context);
  },
});

const authenticatedApi = import("../supabase/functions/google-sync/index.ts");
const scheduledApi = import("../supabase/functions/google-sync-scheduled/index.ts");

function request(reason) {
  return new Request("https://project.test/google-sync", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
  });
}

test("manual sync records and runs only the authenticated caller connection", async () => {
  const { createGoogleSyncHandler } = await authenticatedApi;
  const calls = [];
  const handler = createGoogleSyncHandler({
    authenticate: async () => ({ userId: "caller-1", accessToken: "token" }),
    store: { request: async (...args) => { calls.push(["request", ...args]); return { accepted: true, connectionId: "connection-1" }; } },
    runConnection: async (...args) => { calls.push(["run", ...args]); },
    defer: (work) => work(),
  });

  const response = await handler(request("manual"));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "syncing" });
  assert.deepEqual(calls, [
    ["request", "caller-1", "manual"],
    ["run", "connection-1"],
  ]);
});

test("app-open sync is a server-throttled no-op inside five minutes", async () => {
  const { createGoogleSyncHandler } = await authenticatedApi;
  let runs = 0;
  const handler = createGoogleSyncHandler({
    authenticate: async () => ({ userId: "caller-1", accessToken: "token" }),
    store: { request: async (_userId, reason) => ({ accepted: reason !== "app_open", connectionId: "connection-1" }) },
    runConnection: async () => { runs += 1; }, defer: (work) => work(),
  });

  const response = await handler(request("app_open"));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "syncing" });
  assert.equal(runs, 0);
});

test("authenticated sync rejects invalid reasons and unauthenticated callers", async () => {
  const { createGoogleSyncHandler } = await authenticatedApi;
  const invalid = await createGoogleSyncHandler({ authenticate: async () => ({ userId: "caller-1" }), store: { request: async () => { throw new Error("must not run"); } } })(request("scheduled"));
  const unauthenticated = await createGoogleSyncHandler({ authenticate: async () => { throw Object.assign(new Error("private"), { status: 401, code: "unauthorized" }); } })(request("manual"));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_request" });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: "unauthorized" });
});

test("scheduled sync pulls and drains bounded batches including recovered leases", async () => {
  const { createScheduledSyncHandler } = await scheduledApi;
  const pulled = [], jobs = [];
  const handler = createScheduledSyncHandler({
    env: (name) => name === "SYNC_CRON_SECRET" ? "cron-secret-value" : undefined,
    store: {
      listDueCalendars: async (limit) => { assert.equal(limit, 10); return Array.from({ length: 10 }, (_, i) => ({ id: `calendar-${i}` })); },
      claimJobs: async (limit, leaseSeconds) => {
        assert.equal(limit, 25); assert.equal(leaseSeconds, 300);
        return [{ id: "pending", claim_token: "a" }, { id: "expired-lease", claim_token: "b", recovered: true }];
      },
    },
    pull: async (calendar) => { pulled.push(calendar.id); },
    push: async (job) => { jobs.push(job.id); },
  });
  const response = await handler(new Request("https://project.test/google-sync-scheduled", { method: "POST", headers: { Authorization: "Bearer cron-secret-value" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { calendarsProcessed: 10, jobsProcessed: 2, workRemaining: true });
  assert.equal(pulled.length, 10);
  assert.deepEqual(jobs, ["pending", "expired-lease"]);
});

test("scheduled sync isolates pull and push failures so later work still runs", async () => {
  const { createScheduledSyncHandler } = await scheduledApi;
  const pulled = [], pushed = [];
  const response = await createScheduledSyncHandler({
    env: () => "cron-secret",
    store: {
      listDueCalendars: async () => [{ id: "pull-fails" }, { id: "pull-runs" }],
      claimJobs: async () => [{ id: "push-fails" }, { id: "push-runs" }],
    },
    pull: async ({ id }) => { pulled.push(id); if (id === "pull-fails") throw new Error("private pull detail"); },
    push: async ({ id }) => { pushed.push(id); if (id === "push-fails") throw new Error("private push detail"); },
  })(new Request("https://project.test/google-sync-scheduled", { method: "POST", headers: { Authorization: "Bearer cron-secret" } }));

  assert.equal(response.status, 200);
  assert.deepEqual(pulled, ["pull-fails", "pull-runs"]);
  assert.deepEqual(pushed, ["push-fails", "push-runs"]);
  assert.deepEqual(await response.json(), { calendarsProcessed: 2, jobsProcessed: 2, failures: 2, workRemaining: false });
});

test("production database composition supplies both worker stores and Google adapters", async () => {
  const { createScheduledDatabaseStore } = await scheduledApi;
  const database = { rpc: async () => ({ data: [], error: null }), from() { throw new Error("query should be lazy"); } };
  const store = createScheduledDatabaseStore(database, { fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(typeof store.pullDependencies?.store.loadMappedEvent, "function");
  assert.equal(typeof store.pullDependencies?.google.list, "function");
  assert.equal(typeof store.pushDependencies?.store.loadContext, "function");
  assert.equal(typeof store.pushDependencies?.google.insert, "function");
});

test("scheduled authorization compares the configured secret without logging it", async () => {
  const { createScheduledSyncHandler } = await scheduledApi;
  const messages = [];
  const previous = console.error;
  console.error = (...values) => messages.push(values.join(" "));
  try {
    const response = await createScheduledSyncHandler({
      env: () => "configured-private-value",
      store: { listDueCalendars: async () => [], claimJobs: async () => [] },
    })(new Request("https://project.test/google-sync-scheduled", { method: "POST", headers: { Authorization: "Bearer wrong-private-value" } }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.doesNotMatch(messages.join("\n"), /configured-private-value|wrong-private-value/);
  } finally { console.error = previous; }
});

test("schedule uses current household membership, five-minute cron, and Vault references", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608260002_google_sync_schedule.sql", import.meta.url), "utf8");
  assert.match(sql, /vault\.decrypted_secrets/);
  assert.match(sql, /project_url/);
  assert.match(sql, /google_sync_cron_secret/);
  assert.match(sql, /\*\/5 \* \* \* \*/);
  assert.doesNotMatch(sql, /Bearer\s+[A-Za-z0-9_-]{16,}/);
  assert.match(sql, /household_members/);
  assert.match(sql, /member\.household_id\s*=\s*google_connections\.household_id/);
  assert.match(sql, /member\.user_id\s*=\s*p_user_id/);
  assert.match(sql, /member\.household_id\s*=\s*conn\.household_id/);
  assert.match(sql, /member\.user_id\s*=\s*conn\.user_id/);
});
