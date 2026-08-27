import test from "node:test";
import assert from "node:assert/strict";

const pushWorker = import("../supabase/functions/_shared/push-worker.ts");

const FAMILY_ID = "12345678-1234-4234-8234-123456789abc";
const STABLE_GOOGLE_ID = "fh12345678123442348234123456789abc";
const NOW = "2026-08-27T14:00:00.000Z";

function job(operation = "create", overrides = {}) {
  return {
    id: "job-1",
    claim_token: "claim-1",
    family_event_id: FAMILY_ID,
    google_event_mapping_id: "mapping-1",
    operation,
    attempt_count: 1,
    ...overrides,
  };
}

function context(overrides = {}) {
  const base = {
    familyEvent: {
      id: FAMILY_ID,
      household_id: "household-1",
      title: "Soccer",
      event_date: "2026-09-02",
      start_time: "18:00",
      end_time: "19:00",
      all_day: false,
      recurrence: "none",
      recurrence_end: null,
      updated_at: "2026-08-27T13:00:00.000Z",
      sync_deleted_at: null,
    },
    mapping: {
      id: "mapping-1",
      family_event_id: FAMILY_ID,
      google_connection_id: "connection-1",
      google_calendar_id: "calendar-row-1",
      google_event_id: STABLE_GOOGLE_ID,
      google_etag: '"etag-before"',
      last_family_updated_at: "2026-08-26T10:00:00.000Z",
      last_google_updated_at: "2026-08-26T10:00:00.000Z",
    },
    connection: {
      id: "connection-1",
      user_id: "owner-1",
      household_id: "household-1",
      connection_state: "active",
    },
    calendar: {
      id: "calendar-row-1",
      google_connection_id: "connection-1",
      google_calendar_id: "family@group.calendar.google.com",
      enabled: true,
      is_writable: true,
    },
    ownerUserId: "owner-1",
    householdTimeZone: "America/Toronto",
  };
  return {
    ...base,
    ...overrides,
    familyEvent: { ...base.familyEvent, ...overrides.familyEvent },
    mapping: { ...base.mapping, ...overrides.mapping },
    connection: { ...base.connection, ...overrides.connection },
    calendar: { ...base.calendar, ...overrides.calendar },
  };
}

function googleEvent(overrides = {}) {
  return {
    id: STABLE_GOOGLE_ID,
    status: "confirmed",
    etag: '"etag-after"',
    updated: "2026-08-27T14:00:01.000Z",
    summary: "Soccer",
    start: { dateTime: "2026-09-02T18:00:00-04:00", timeZone: "America/Toronto" },
    end: { dateTime: "2026-09-02T19:00:00-04:00", timeZone: "America/Toronto" },
    ...overrides,
  };
}

function fakeDeps(options = {}) {
  const calls = [];
  const loaded = options.context ?? context();
  const store = {
    loadContext: async (claimedJob) => {
      calls.push(["load", claimedJob.id, claimedJob.claim_token]);
      return loaded;
    },
    complete: async (jobId, claimToken, completion) => {
      calls.push(["complete", jobId, claimToken, completion]);
    },
    fail: async (jobId, claimToken, category, safeMessage, nextAttemptAt) => {
      calls.push(["fail", jobId, claimToken, category, safeMessage, nextAttemptAt]);
    },
    markReconnect: async (connectionId, userId) => {
      calls.push(["reconnect", connectionId, userId]);
    },
    ...options.store,
  };
  const google = {
    insert: async (...args) => {
      calls.push(["insert", ...args]);
      return googleEvent();
    },
    update: async (...args) => {
      calls.push(["update", ...args]);
      return googleEvent();
    },
    get: async (...args) => {
      calls.push(["get", ...args]);
      return googleEvent();
    },
    delete: async (...args) => {
      calls.push(["delete", ...args]);
      return { status: 204 };
    },
    ...options.google,
  };
  return { store, google, now: () => NOW, jitter: () => 0, calls };
}

function call(deps, name) {
  return deps.calls.find(([candidate]) => candidate === name);
}

test("create uses the UUID-derived stable Google ID and records confirmation atomically", async () => {
  const { processPushJob } = await pushWorker;
  const deps = fakeDeps();

  const result = await processPushJob(job("create"), deps);

  assert.deepEqual(result, { status: "complete", finalizeLocalDelete: false });
  const insert = call(deps, "insert");
  assert.equal(insert[3], "family@group.calendar.google.com");
  assert.equal(insert[4], STABLE_GOOGLE_ID);
  assert.deepEqual(insert[5], {
    summary: "Soccer",
    start: { dateTime: "2026-09-02T18:00:00", timeZone: "America/Toronto" },
    end: { dateTime: "2026-09-02T19:00:00", timeZone: "America/Toronto" },
  });
  assert.deepEqual(call(deps, "complete"), ["complete", "job-1", "claim-1", {
    finalizeLocalDelete: false,
    mapping: {
      google_event_id: STABLE_GOOGLE_ID,
      google_etag: '"etag-after"',
      google_updated_at: "2026-08-27T14:00:01.000Z",
      last_family_updated_at: "2026-08-27T13:00:00.000Z",
      last_google_updated_at: "2026-08-27T14:00:01.000Z",
      sync_state: "synced",
      safe_error_message: null,
    },
  }]);
});

test("update sends the stored ETag in If-Match and updates observed timestamps", async () => {
  const { processPushJob } = await pushWorker;
  const deps = fakeDeps();

  await processPushJob(job("update"), deps);

  assert.deepEqual(call(deps, "update")[6], { ifMatch: '"etag-before"' });
  assert.equal(call(deps, "complete")[3].mapping.last_family_updated_at, "2026-08-27T13:00:00.000Z");
  assert.equal(call(deps, "complete")[3].mapping.last_google_updated_at, "2026-08-27T14:00:01.000Z");
});

test("a 412 update fetches current state and keeps a newer Google event", async () => {
  const { GooglePushError, processPushJob } = await pushWorker;
  const remote = googleEvent({ updated: "2026-08-27T15:00:00.000Z", etag: '"google-newer"' });
  const deps = fakeDeps({
    google: {
      update: async (...args) => {
        deps.calls.push(["update", ...args]);
        throw new GooglePushError("validation", 412);
      },
      get: async (...args) => {
        deps.calls.push(["get", ...args]);
        return remote;
      },
    },
  });

  const result = await processPushJob(job("update"), deps);

  assert.equal(result.conflictWinner, "google");
  assert.equal(deps.calls.filter(([name]) => name === "update").length, 1);
  const completion = call(deps, "complete")[3];
  assert.deepEqual(completion.reconcileGoogleEvent, remote);
  assert.equal(completion.mapping.google_etag, '"google-newer"');
  assert.equal(completion.captureReconciledFamilyUpdatedAt, true);
  assert.equal("last_family_updated_at" in completion.mapping, false,
    "the store must capture the post-reconciliation database timestamp, not reuse the stale pre-conflict value");
});

test("a 412 update retries once with the fresh ETag when Family Hub wins", async () => {
  const { GooglePushError, processPushJob } = await pushWorker;
  const remote = googleEvent({ updated: "2026-08-26T11:00:00.000Z", etag: '"fresh-etag"' });
  let attempts = 0;
  const deps = fakeDeps({
    google: {
      update: async (...args) => {
        deps.calls.push(["update", ...args]);
        attempts += 1;
        if (attempts === 1) throw new GooglePushError("validation", 412);
        return googleEvent({ etag: '"after-retry"' });
      },
      get: async (...args) => {
        deps.calls.push(["get", ...args]);
        return remote;
      },
    },
  });

  const result = await processPushJob(job("update"), deps);

  assert.equal(result.status, "complete");
  assert.equal(result.conflictWinner, "family");
  assert.equal(deps.calls.filter(([name]) => name === "update").length, 2);
  assert.deepEqual(deps.calls.filter(([name]) => name === "update")[1][6], { ifMatch: '"fresh-etag"' });
});

test("delete accepts 204, 404, and a cancelled event and finalizes locally", async () => {
  const { GooglePushError, processPushJob } = await pushWorker;
  for (const response of [
    async () => ({ status: 204 }),
    async () => { throw new GooglePushError("permanent", 404); },
    async () => ({ status: 200, event: googleEvent({ status: "cancelled" }) }),
  ]) {
    const deps = fakeDeps({ google: { delete: response } });
    const result = await processPushJob(job("delete"), deps);
    assert.deepEqual(result, { status: "complete", finalizeLocalDelete: true });
    assert.deepEqual(call(deps, "complete"), ["complete", "job-1", "claim-1", { finalizeLocalDelete: true }]);
  }
});

test("attempted create-delete derives the stable ID when no mapped Google ID was confirmed", async () => {
  const { processPushJob } = await pushWorker;
  const deps = fakeDeps({ context: context({ mapping: { google_event_id: "" } }) });

  await processPushJob(job("delete"), deps);

  assert.equal(call(deps, "delete")[4], STABLE_GOOGLE_ID);
});

test("ambiguous create replay confirms the stable event after an insert collision", async () => {
  const { GooglePushError, processPushJob } = await pushWorker;
  let run = 0;
  const deps = fakeDeps({
    google: {
      insert: async (...args) => {
        deps.calls.push(["insert", ...args]);
        run += 1;
        if (run === 1) throw new GooglePushError("transient", 503, "socket included a secret");
        throw new GooglePushError("validation", 409, "duplicate included a secret");
      },
    },
  });

  const first = await processPushJob(job("create"), deps);
  assert.equal(first.status, "retry");
  assert.equal(call(deps, "complete"), undefined);

  const second = await processPushJob(job("create", { attempt_count: 2 }), deps);
  assert.equal(second.status, "complete");
  assert.equal(deps.calls.filter(([name]) => name === "get")[0][4], STABLE_GOOGLE_ID);
  assert.equal(deps.calls.filter(([name]) => name === "complete").length, 1);
});

test("read-only or cross-owner destinations fail safely before a Google write", async () => {
  const { processPushJob } = await pushWorker;
  for (const invalidContext of [
    context({ calendar: { is_writable: false } }),
    context({ calendar: { enabled: false } }),
    context({ connection: { connection_state: "reconnect_required" } }),
    context({ connection: { user_id: "another-owner" } }),
    context({ connection: { household_id: "another-household" } }),
    context({ mapping: { google_connection_id: "another-connection" } }),
  ]) {
    const deps = fakeDeps({ context: invalidContext });
    const result = await processPushJob(job("update"), deps);
    assert.equal(result.status, "failed");
    assert.equal(deps.calls.some(([name]) => ["insert", "update", "delete"].includes(name)), false);
    assert.deepEqual(call(deps, "fail").slice(1, 5), ["job-1", "claim-1", "permission", "Google calendar is not writable"]);
  }
});

test("authorization failure marks reconnect and stores only a sanitized categorized error", async () => {
  const { GooglePushError, processPushJob } = await pushWorker;
  const deps = fakeDeps({ google: {
    update: async () => { throw new GooglePushError("authorization", 401, "access_token=private"); },
  } });

  const result = await processPushJob(job("update"), deps);

  assert.deepEqual(result, { status: "failed", finalizeLocalDelete: false, errorCategory: "authorization" });
  assert.deepEqual(call(deps, "reconnect"), ["reconnect", "connection-1", "owner-1"]);
  assert.deepEqual(call(deps, "fail"), ["fail", "job-1", "claim-1", "authorization", "Google authorization needs reconnecting", null]);
  assert.doesNotMatch(JSON.stringify(deps.calls), /access_token=private/);
});

test("transient failures use retry policy and fence failure with the claim token", async () => {
  const { GooglePushError, processPushJob } = await pushWorker;
  const deps = fakeDeps({ google: {
    update: async () => { throw new GooglePushError("rate_limit", 429, "quota project private"); },
  } });

  const result = await processPushJob(job("update"), deps);

  assert.deepEqual(result, { status: "retry", finalizeLocalDelete: false, errorCategory: "rate_limit" });
  assert.deepEqual(call(deps, "fail"), ["fail", "job-1", "claim-1", "rate_limit", "Google Calendar is temporarily busy", "2026-08-27T14:01:00.000Z"]);
  assert.doesNotMatch(JSON.stringify(deps.calls), /quota project private/);
});

test("a refreshed authorization path can complete without reconnect state", async () => {
  const { processPushJob } = await pushWorker;
  let refreshed = false;
  const deps = fakeDeps({ google: {
    update: async (...args) => {
      deps.calls.push(["update", ...args]);
      refreshed = true;
      return googleEvent();
    },
  } });

  const result = await processPushJob(job("update"), deps);

  assert.equal(refreshed, true);
  assert.equal(result.status, "complete");
  assert.equal(call(deps, "reconnect"), undefined);
});
