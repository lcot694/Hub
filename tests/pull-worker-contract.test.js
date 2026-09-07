import test from "node:test";
import assert from "node:assert/strict";
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

const pullWorker = import("../supabase/functions/_shared/pull-worker.ts");
const tokenCrypto = import("../supabase/functions/_shared/crypto.ts");

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SYNC_TOKEN = "sync-before";
const NEXT_SYNC_TOKEN = "sync-after";

function calendar(overrides = {}) {
  const base = {
    id: "calendar-row-1",
    google_connection_id: "connection-1",
    google_calendar_id: "family@group.calendar.google.com",
    enabled: true,
    is_writable: false,
    sync_token: SYNC_TOKEN,
    sync_version: "calendar-version-1",
    time_zone: "America/Toronto",
    ownerUserId: "owner-1",
    householdTimeZone: "America/Toronto",
    connection: {
      id: "connection-1",
      user_id: "owner-1",
      household_id: "household-1",
      person_id: "person-default",
      connection_state: "active",
    },
  };
  return {
    ...base,
    ...overrides,
    connection: { ...base.connection, ...overrides.connection },
  };
}

function googleEvent(id, overrides = {}) {
  return {
    id,
    status: "confirmed",
    etag: `"${id}-etag"`,
    updated: "2026-08-27T14:00:00.000Z",
    summary: `Event ${id}`,
    start: { dateTime: "2026-09-02T18:00:00-04:00", timeZone: "America/Toronto" },
    end: { dateTime: "2026-09-02T19:00:00-04:00", timeZone: "America/Toronto" },
    ...overrides,
  };
}

function mappedRecord(id = "remote-1", overrides = {}) {
  const base = {
    mapping: {
      id: `mapping-${id}`,
      family_event_id: `family-${id}`,
      google_connection_id: "connection-1",
      google_calendar_id: "calendar-row-1",
      google_event_id: id,
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: `mapping-version-${id}-1`,
      google_etag: '"old-etag"',
      google_updated_at: "2026-08-26T10:00:00.000Z",
      last_family_updated_at: "2026-08-26T10:00:00.000Z",
      last_google_updated_at: "2026-08-26T10:00:00.000Z",
      sync_state: "synced",
    },
    familyEvent: {
      id: `family-${id}`,
      household_id: "household-1",
      person_id: "person-custom",
      title: "Old local title",
      event_date: "2026-09-01",
      start_time: "10:00",
      end_time: "11:00",
      all_day: false,
      recurrence: "none",
      recurrence_end: null,
      created_by: "creator-1",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-08-26T10:00:00.000Z",
      sync_deleted_at: null,
      local_note: "bring snacks",
    },
  };
  return {
    mapping: { ...base.mapping, ...overrides.mapping },
    familyEvent: { ...base.familyEvent, ...overrides.familyEvent },
    syncRelevantFamilyUpdatedAt:
      overrides.syncRelevantFamilyUpdatedAt ?? overrides.familyEvent?.updated_at ?? base.familyEvent.updated_at,
  };
}

function fakePullDeps(options = {}) {
  const calls = [];
  const records = new Map(
    (options.records || []).map((record) => [record.mapping.google_event_id, structuredClone(record)]),
  );
  const pages = [...(options.pages || [{ items: [], nextSyncToken: NEXT_SYNC_TOKEN }])];
  let pageIndex = 0;
  let scanCounter = 0;
  let versionCounter = 1;
  let initialized = false;
  let currentSyncToken = options.currentSyncToken;
  let currentSyncVersion = options.currentSyncVersion;
  let activeScan = null;
  const deleted = [];
  const savedSyncTokens = [];
  const queued = new Map();
  const pendingCancellations = new Map();

  function initialize(selected) {
    if (initialized) return;
    initialized = true;
    currentSyncToken = options.currentSyncToken === undefined ? selected.sync_token : options.currentSyncToken;
    currentSyncVersion = options.currentSyncVersion || selected.sync_version;
  }

  function nextVersion(prefix) {
    versionCounter += 1;
    return `${prefix}-version-${versionCounter}`;
  }

  function concurrencyError() {
    return Object.assign(new Error("stale pull state"), { category: "transient", status: 409 });
  }

  function assertRun(selected, reconciliation) {
    initialize(selected);
    if (reconciliation.scan) {
      if (!activeScan || activeScan.scanId !== reconciliation.scan.scanId ||
          activeScan.generation !== reconciliation.scan.generation) throw concurrencyError();
      return;
    }
    if (activeScan || reconciliation.run.expectedSyncToken !== currentSyncToken ||
        reconciliation.run.expectedSyncVersion !== currentSyncVersion) throw concurrencyError();
  }

  function assertExpected(existing, change) {
    if (!existing || !change.expected ||
        existing.mapping.updated_at !== change.expected.mappingUpdatedAt ||
        existing.familyEvent.updated_at !== change.expected.familyUpdatedAt) throw concurrencyError();
  }

  function applyQueuePolicy(targetQueue, change) {
    if (change.queuePolicy === "ensure_update") targetQueue.set(change.familyEventId, "pending_update");
    if (change.queuePolicy === "supersede_pending") targetQueue.set(change.familyEventId, "superseded");
  }

  function captureMapping(existing, change, captureFamily) {
    Object.assign(existing.mapping, change.mapping || {});
    if (captureFamily) existing.mapping.last_family_updated_at = existing.syncRelevantFamilyUpdatedAt;
    existing.mapping.updated_at = nextVersion(`mapping-${change.googleEventId}`);
  }

  function finalizeControlledCancellations(familyEventIds, run) {
    for (const familyEventId of new Set(familyEventIds)) {
      const guard = pendingCancellations.get(familyEventId);
      if (!guard || guard.expectedSyncToken !== run.expectedSyncToken ||
          guard.expectedSyncVersion !== run.expectedSyncVersion) continue;
      const entry = [...records.entries()].find(([, record]) => record.familyEvent.id === familyEventId);
      if (!entry) continue;
      const [googleEventId, record] = entry;
      if (record.mapping.updated_at === guard.mappingUpdatedAt &&
          record.familyEvent.updated_at === guard.familyUpdatedAt) {
        records.delete(googleEventId);
        deleted.push(googleEventId);
        queued.delete(familyEventId);
      } else {
        record.familyEvent.sync_deleted_at = null;
        record.mapping.sync_state = "needs_attention";
        record.mapping.safe_error_message = "Family event changed while applying a Google cancellation";
        record.mapping.updated_at = nextVersion(`mapping-${googleEventId}`);
        queued.set(familyEventId, "superseded");
      }
      pendingCancellations.delete(familyEventId);
    }
  }

  const store = {
    async loadMappedEvent(selected, googleEventId) {
      initialize(selected);
      calls.push(["load", selected.id, googleEventId]);
      const record = records.get(googleEventId);
      return record ? structuredClone(record) : null;
    },
    async applyPage(selected, changes, reconciliation) {
      calls.push(["apply", selected.id, structuredClone(changes), structuredClone(reconciliation)]);
      assertRun(selected, reconciliation);
      const working = structuredClone(records);
      const workingQueue = structuredClone(queued);
      const workingCancellations = structuredClone(pendingCancellations);
      const pendingSeen = [];
      for (const change of changes) {
        const existing = working.get(change.googleEventId);
        if (change.kind === "import") {
          if (!existing) {
            const capturedFamilyUpdatedAt = "2026-08-27T14:01:00.000Z";
            working.set(change.googleEventId, {
              mapping: {
                id: `mapping-${change.googleEventId}`,
                family_event_id: `family-${change.googleEventId}`,
                google_connection_id: selected.google_connection_id,
                google_calendar_id: selected.id,
                google_event_id: change.googleEventId,
                created_at: "2026-08-27T14:01:00.000Z",
                updated_at: nextVersion(`mapping-${change.googleEventId}`),
                google_etag: change.mapping.google_etag,
                google_updated_at: change.mapping.google_updated_at,
                last_family_updated_at: capturedFamilyUpdatedAt,
                last_google_updated_at: change.mapping.last_google_updated_at,
                sync_state: change.mapping.sync_state,
                safe_error_message: change.mapping.safe_error_message,
              },
              familyEvent: {
                id: `family-${change.googleEventId}`,
                ...change.familyEvent,
                created_by: "owner-1",
                created_at: "2026-08-27T14:01:00.000Z",
                updated_at: capturedFamilyUpdatedAt,
                sync_deleted_at: null,
              },
              syncRelevantFamilyUpdatedAt: capturedFamilyUpdatedAt,
            });
          } else {
            if (existing.mapping.google_connection_id !== selected.google_connection_id ||
                existing.mapping.google_calendar_id !== selected.id) throw concurrencyError();
          }
          applyQueuePolicy(workingQueue, change);
          continue;
        }
        if (!existing) continue;
        if (change.kind !== "ignore") assertExpected(existing, change);
        if (change.kind === "update") {
          const capturedFamilyUpdatedAt = "2026-08-27T14:01:00.000Z";
          Object.assign(existing.familyEvent, change.familyEventPatch);
          existing.familyEvent.updated_at = capturedFamilyUpdatedAt;
          existing.syncRelevantFamilyUpdatedAt = capturedFamilyUpdatedAt;
          captureMapping(existing, change, true);
        } else if (change.kind === "cancel") {
          const capturedFamilyUpdatedAt = "2026-08-27T14:01:00.000Z";
          existing.familyEvent.sync_deleted_at = change.googleUpdatedAt || capturedFamilyUpdatedAt;
          existing.familyEvent.updated_at = capturedFamilyUpdatedAt;
          existing.syncRelevantFamilyUpdatedAt = capturedFamilyUpdatedAt;
          captureMapping(existing, change, true);
          workingCancellations.set(change.familyEventId, {
            ...reconciliation.run,
            mappingUpdatedAt: existing.mapping.updated_at,
            familyUpdatedAt: existing.familyEvent.updated_at,
          });
        } else if (change.kind !== "ignore") {
          captureMapping(existing, change, false);
        }
        applyQueuePolicy(workingQueue, change);
      }
      if (reconciliation.scan) pendingSeen.push(...reconciliation.seenGoogleEventIds);
      records.clear();
      for (const [id, record] of working) records.set(id, record);
      queued.clear();
      for (const [id, status] of workingQueue) queued.set(id, status);
      pendingCancellations.clear();
      for (const [id, guard] of workingCancellations) pendingCancellations.set(id, guard);
      if (activeScan) for (const id of pendingSeen) activeScan.seen.add(id);
    },
    async completeIncrementalPull(selected, run, nextSyncToken, pendingCancellationFamilyEventIds) {
      calls.push(["complete-incremental", selected.id, structuredClone(run), nextSyncToken,
        structuredClone(pendingCancellationFamilyEventIds)]);
      initialize(selected);
      if (activeScan || run.expectedSyncToken !== currentSyncToken ||
          run.expectedSyncVersion !== currentSyncVersion) throw concurrencyError();
      finalizeControlledCancellations(pendingCancellationFamilyEventIds, run);
      currentSyncToken = nextSyncToken;
      currentSyncVersion = nextVersion("calendar");
      savedSyncTokens.push(nextSyncToken);
    },
    async beginFullReconciliation(selected, run) {
      initialize(selected);
      if (activeScan || run.expectedSyncToken !== currentSyncToken ||
          run.expectedSyncVersion !== currentSyncVersion) throw concurrencyError();
      const scan = {
        scanId: `scan-${++scanCounter}`,
        generation: scanCounter,
        startedAt: `2026-08-27T14:00:0${scanCounter}.000Z`,
      };
      activeScan = {
        ...scan,
        run: structuredClone(run),
        seen: new Set(),
        candidates: new Map([...records].map(([id, record]) => [id, {
          mappingUpdatedAt: record.mapping.updated_at,
          familyUpdatedAt: record.familyEvent.updated_at,
        }])),
      };
      currentSyncToken = null;
      calls.push(["begin-full", selected.id, structuredClone(run), structuredClone(scan)]);
      return scan;
    },
    async finishFullReconciliation(selected, scan, nextSyncToken, pendingCancellationFamilyEventIds) {
      calls.push(["finish-full", selected.id, structuredClone(scan), nextSyncToken,
        structuredClone(pendingCancellationFamilyEventIds)]);
      initialize(selected);
      if (!activeScan || activeScan.scanId !== scan.scanId || activeScan.generation !== scan.generation) {
        throw concurrencyError();
      }
      for (const [id, expected] of activeScan.candidates) {
        const record = records.get(id);
        if (!activeScan.seen.has(id) &&
            record?.mapping.updated_at === expected.mappingUpdatedAt &&
            record?.familyEvent.updated_at === expected.familyUpdatedAt) {
          records.delete(id);
          deleted.push(id);
          queued.delete(record.familyEvent.id);
        }
      }
      finalizeControlledCancellations(pendingCancellationFamilyEventIds, activeScan.run);
      currentSyncToken = nextSyncToken;
      currentSyncVersion = nextVersion("calendar");
      savedSyncTokens.push(nextSyncToken);
      activeScan = null;
    },
    async abortFullReconciliation(selected, scan) {
      calls.push(["abort-full", selected.id, structuredClone(scan)]);
      if (activeScan?.scanId === scan.scanId && activeScan.generation === scan.generation) activeScan = null;
    },
    async markReconnect(connectionId, ownerUserId) {
      calls.push(["reconnect", connectionId, ownerUserId]);
    },
    async recordFailure(selected, category, safeMessage) {
      calls.push(["failure", selected.id, category, safeMessage]);
    },
    ...options.store,
  };
  const google = {
    async list(_connection, selected, googleCalendarId, request) {
      calls.push(["list", selected.id, googleCalendarId, structuredClone(request)]);
      const page = pages[pageIndex++];
      if (page instanceof Error) throw page;
      return page;
    },
    ...options.google,
  };
  return {
    store, google, calls, records, deleted, savedSyncTokens, queued,
    state: {
      get syncToken() { return currentSyncToken; },
      get syncVersion() { return currentSyncVersion; },
      get activeScan() { return activeScan; },
    },
    enqueuePages(...additionalPages) { pages.push(...additionalPages); },
  };
}

function calls(deps, name) {
  return deps.calls.filter(([candidate]) => candidate === name);
}

test("incremental pull traverses every page with the saved token and commits only the final token", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({ pages: [
    { items: [googleEvent("one")], nextPageToken: "page-2" },
    { items: [googleEvent("two")], nextSyncToken: NEXT_SYNC_TOKEN },
  ] });

  const result = await pullCalendar(calendar(), deps);

  assert.deepEqual(result, {
    status: "complete", mode: "incremental", pages: 2, processed: 2, nextSyncToken: NEXT_SYNC_TOKEN,
  });
  assert.deepEqual(calls(deps, "list").map((entry) => entry[3]), [
    { singleEvents: false, showDeleted: true, syncToken: SYNC_TOKEN },
    { singleEvents: false, showDeleted: true, syncToken: SYNC_TOKEN, pageToken: "page-2" },
  ]);
  assert.deepEqual(deps.savedSyncTokens, [NEXT_SYNC_TOKEN]);
});

test("a failed second page does not advance the saved sync token", async () => {
  const { GooglePullError, pullCalendar } = await pullWorker;
  const failure = Object.assign(new Error("response leaked access_token=secret"), { status: 503 });
  const deps = fakePullDeps({ pages: [
    { items: [googleEvent("one")], nextPageToken: "page-2" },
    failure,
  ] });

  await assert.rejects(() => pullCalendar(calendar(), deps), (error) => {
    assert.ok(error instanceof GooglePullError);
    assert.equal(error.message, "Google Calendar is temporarily unavailable");
    assert.doesNotMatch(String(error), /access_token|secret/i);
    return true;
  });
  assert.equal(calls(deps, "apply").length, 1, "bounded successful pages may commit");
  assert.deepEqual(deps.savedSyncTokens, []);
  assert.deepEqual(calls(deps, "failure")[0].slice(2), ["transient", "Google Calendar is temporarily unavailable"]);
});

test("new Google events import once with the connection's default person", async () => {
  const { pullCalendar } = await pullWorker;
  const duplicate = googleEvent("new-event", { summary: "School assembly" });
  const deps = fakePullDeps({ pages: [
    { items: [duplicate], nextPageToken: "page-2" },
    { items: [duplicate], nextSyncToken: NEXT_SYNC_TOKEN },
  ] });

  await pullCalendar(calendar(), deps);

  assert.equal(deps.records.size, 1, "the scoped mapping upsert is unique under replay");
  assert.equal(deps.records.get("new-event").familyEvent.person_id, "person-default");
  assert.equal(deps.records.get("new-event").familyEvent.title, "School assembly");
  assert.equal(deps.records.get("new-event").mapping.sync_state, "read_only",
    "events from enabled reader calendars remain visible but cannot become writable");
  assert.equal(deps.records.get("new-event").mapping.safe_error_message, "Google calendar is read-only");
  assert.deepEqual(calls(deps, "apply").map((entry) => entry[2][0].kind), ["import", "update"]);
});

test("mapped Google updates preserve the assigned person and Family-Hub-only metadata", async () => {
  const { pullCalendar } = await pullWorker;
  const existing = mappedRecord();
  const deps = fakePullDeps({
    records: [existing],
    pages: [{ items: [googleEvent("remote-1", { summary: "New remote title" })], nextSyncToken: NEXT_SYNC_TOKEN }],
  });

  await pullCalendar(calendar(), deps);

  const updated = deps.records.get("remote-1").familyEvent;
  assert.equal(updated.title, "New remote title");
  assert.equal(updated.person_id, "person-custom");
  assert.equal(updated.created_by, "creator-1");
  assert.equal(updated.created_at, "2026-01-01T00:00:00.000Z");
  assert.equal(updated.local_note, "bring snacks");
  const patch = calls(deps, "apply")[0][2][0].familyEventPatch;
  assert.equal("person_id" in patch, false);
  assert.equal("household_id" in patch, false);
});

test("the most recent timestamp wins a mapped conflict and an exact tie goes to Google", async () => {
  const { pullCalendar } = await pullWorker;
  const familyNewer = mappedRecord("family-newer", {
    familyEvent: { updated_at: "2026-08-27T15:00:00.000Z", title: "Keep local" },
  });
  const exactTie = mappedRecord("exact-tie", {
    familyEvent: { updated_at: "2026-08-27T14:00:00.000Z", title: "Old local" },
  });
  const deps = fakePullDeps({
    records: [familyNewer, exactTie],
    pages: [{ items: [
      googleEvent("family-newer", { summary: "Older remote" }),
      googleEvent("exact-tie", { summary: "Tie remote" }),
    ], nextSyncToken: NEXT_SYNC_TOKEN }],
  });

  await pullCalendar(calendar(), deps);

  assert.equal(deps.records.get("family-newer").familyEvent.title, "Keep local");
  assert.equal(deps.records.get("exact-tie").familyEvent.title, "Tie remote");
  assert.deepEqual(calls(deps, "apply")[0][2].map(({ kind, conflictWinner }) => [kind, conflictWinner]), [
    ["keep_family", "family"],
    ["update", "google"],
  ]);
});

test("Google cancellations delete only mapped events when Google wins", async () => {
  const { pullCalendar } = await pullWorker;
  const googleWins = mappedRecord("cancel-google");
  const familyWins = mappedRecord("cancel-family", {
    familyEvent: { updated_at: "2026-08-27T16:00:00.000Z" },
  });
  const deps = fakePullDeps({
    records: [googleWins, familyWins],
    pages: [{ items: [
      googleEvent("cancel-google", { status: "cancelled" }),
      googleEvent("cancel-family", { status: "cancelled" }),
      { id: "unknown-cancel", status: "cancelled" },
    ], nextSyncToken: NEXT_SYNC_TOKEN }],
  });

  await pullCalendar(calendar(), deps);

  assert.deepEqual(deps.deleted, ["cancel-google"]);
  assert.equal(deps.records.get("cancel-family").familyEvent.sync_deleted_at, null);
  assert.deepEqual(calls(deps, "apply")[0][2].map(({ kind }) => kind), ["cancel", "cancellation_conflict", "ignore"]);
  const conflict = calls(deps, "apply")[0][2][1];
  assert.equal(conflict.mapping.sync_state, "needs_attention");
  assert.equal(conflict.mapping.safe_error_message, "Google deleted this event while Family Hub had newer changes");
  assert.equal("familyEventPatch" in conflict, false, "the pull must neither delete nor resurrect the event");
});

test("unsupported complex recurrence becomes read-only without overwriting mapped Family data", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({
    records: [mappedRecord("complex")],
    pages: [{ items: [googleEvent("complex", {
      summary: "Private changed title",
      recurrence: ["RRULE:FREQ=WEEKLY", "EXDATE;VALUE=DATE:20260909"],
    })], nextSyncToken: NEXT_SYNC_TOKEN }],
  });

  await pullCalendar(calendar(), deps);

  assert.equal(deps.records.get("complex").familyEvent.title, "Old local title");
  assert.equal(deps.records.get("complex").mapping.sync_state, "read_only");
  const change = calls(deps, "apply")[0][2][0];
  assert.equal(change.kind, "read_only");
  assert.equal(change.mapping.safe_error_message, "Google event has an unsupported recurrence pattern");
  assert.doesNotMatch(JSON.stringify(change), /Private changed title/);
});

test("an expired sync token clears it and performs a full reconciliation", async () => {
  const { pullCalendar } = await pullWorker;
  const expired = Object.assign(new Error("expired token detail"), { status: 410 });
  const deps = fakePullDeps({ pages: [
    expired,
    { items: [googleEvent("seen")], nextPageToken: "full-page-2" },
    { items: [googleEvent("also-seen")], nextSyncToken: "fresh-full-token" },
  ] });

  const result = await pullCalendar(calendar(), deps);

  assert.deepEqual(result, {
    status: "complete", mode: "full", pages: 2, processed: 2, nextSyncToken: "fresh-full-token",
  });
  assert.equal(calls(deps, "begin-full").length, 1);
  assert.deepEqual(calls(deps, "begin-full")[0][2], {
    expectedSyncToken: SYNC_TOKEN,
    expectedSyncVersion: "calendar-version-1",
  });
  assert.deepEqual(calls(deps, "list").map((entry) => entry[3]), [
    { singleEvents: false, showDeleted: true, syncToken: SYNC_TOKEN },
    { singleEvents: false, showDeleted: true },
    { singleEvents: false, showDeleted: true, pageToken: "full-page-2" },
  ]);
  assert.deepEqual(deps.savedSyncTokens, ["fresh-full-token"]);
});

test("full reconciliation marks every seen ID and defers unseen deletion until the scan completes", async () => {
  const { pullCalendar } = await pullWorker;
  const selected = calendar({ sync_token: null });
  const deps = fakePullDeps({
    records: [mappedRecord("seen"), mappedRecord("unseen")],
    pages: [
      { items: [googleEvent("seen")], nextPageToken: "page-2" },
      { items: [], nextSyncToken: "full-token" },
    ],
  });
  let releaseSecondPage;
  const originalList = deps.google.list;
  deps.google.list = async (...args) => {
    if (calls(deps, "list").length === 1) {
      return await new Promise((resolve) => { releaseSecondPage = () => resolve(originalList(...args)); });
    }
    return await originalList(...args);
  };

  const pulling = pullCalendar(selected, deps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deps.deleted, [], "unseen records remain while the full scan is incomplete");
  assert.deepEqual(calls(deps, "apply")[0][3].seenGoogleEventIds, ["seen"]);
  releaseSecondPage();
  await pulling;
  assert.deepEqual(deps.deleted, ["unseen"]);
  assert.equal(calls(deps, "finish-full").length, 1);
});

test("a failed full scan never deletes unseen records or stores its token", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({
    records: [mappedRecord("seen"), mappedRecord("unseen")],
    pages: [
      { items: [googleEvent("seen")], nextPageToken: "page-2" },
      Object.assign(new Error("private page failure"), { status: 503 }),
    ],
  });

  await assert.rejects(() => pullCalendar(calendar({ sync_token: null }), deps));

  assert.deepEqual(deps.deleted, []);
  assert.equal(calls(deps, "finish-full").length, 0);
  assert.deepEqual(deps.savedSyncTokens, []);
});

test("pull rejects inactive, disabled, or cross-owner/calendar scope before Google access", async () => {
  const { pullCalendar } = await pullWorker;
  for (const selected of [
    calendar({ enabled: false }),
    calendar({ connection: { connection_state: "reconnect_required" } }),
    calendar({ ownerUserId: "another-owner" }),
    calendar({ google_connection_id: "another-connection" }),
  ]) {
    const deps = fakePullDeps();
    await assert.rejects(() => pullCalendar(selected, deps), (error) => {
      assert.equal(error.category, "permission");
      assert.equal(error.message, "Google calendar is not available for synchronization");
      return true;
    });
    assert.equal(calls(deps, "list").length, 0);
  }
});

test("authorization failures mark only the owned connection and expose a sanitized error", async () => {
  const { GooglePullError, pullCalendar } = await pullWorker;
  const deps = fakePullDeps({ pages: [
    Object.assign(new Error("refresh_token=private"), { category: "authorization", status: 401 }),
  ] });

  await assert.rejects(() => pullCalendar(calendar(), deps), (error) => {
    assert.ok(error instanceof GooglePullError);
    assert.equal(error.message, "Google authorization needs reconnecting");
    return true;
  });
  assert.deepEqual(calls(deps, "reconnect"), [["reconnect", "connection-1", "owner-1"]]);
  assert.deepEqual(calls(deps, "failure")[0].slice(2), ["authorization", "Google authorization needs reconnecting"]);
  assert.doesNotMatch(JSON.stringify(deps.calls), /refresh_token|private/i);
});

test("a concurrent Family edit fails the page CAS instead of being overwritten", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({
    records: [mappedRecord("stale")],
    pages: [{ items: [googleEvent("stale", { summary: "Remote overwrite" })], nextSyncToken: NEXT_SYNC_TOKEN }],
  });
  const applyPage = deps.store.applyPage;
  deps.store.applyPage = async (...args) => {
    const live = deps.records.get("stale");
    live.familyEvent.title = "Concurrent local edit";
    live.familyEvent.updated_at = "2026-08-27T14:00:01.000Z";
    live.syncRelevantFamilyUpdatedAt = "2026-08-27T14:00:01.000Z";
    return await applyPage(...args);
  };

  await assert.rejects(() => pullCalendar(calendar({ is_writable: true }), deps), (error) => {
    assert.equal(error.category, "transient");
    return true;
  });

  assert.equal(deps.records.get("stale").familyEvent.title, "Concurrent local edit");
  assert.deepEqual(deps.savedSyncTokens, []);
});

test("a person-only edit does not defeat a newer Google-owned field update", async () => {
  const { pullCalendar } = await pullWorker;
  const personOnly = mappedRecord("person-only", {
    familyEvent: {
      updated_at: "2026-08-27T15:00:00.000Z",
      person_id: "new-person-assignment",
    },
    syncRelevantFamilyUpdatedAt: "2026-08-26T10:00:00.000Z",
  });
  const deps = fakePullDeps({
    records: [personOnly],
    pages: [{ items: [googleEvent("person-only", { summary: "Remote title wins" })], nextSyncToken: NEXT_SYNC_TOKEN }],
  });

  await pullCalendar(calendar({ is_writable: true }), deps);

  assert.equal(deps.records.get("person-only").familyEvent.title, "Remote title wins");
  assert.equal(deps.records.get("person-only").familyEvent.person_id, "new-person-assignment");
  assert.equal(calls(deps, "apply")[0][2][0].conflictWinner, "google");
});

test("unsupported recurrence becomes read-only even when synchronized Family fields are newer", async () => {
  const { pullCalendar } = await pullWorker;
  const localNewer = mappedRecord("complex-local-newer", {
    familyEvent: { updated_at: "2026-08-27T16:00:00.000Z", title: "Keep local safely" },
    syncRelevantFamilyUpdatedAt: "2026-08-27T16:00:00.000Z",
  });
  const deps = fakePullDeps({
    records: [localNewer],
    pages: [{ items: [googleEvent("complex-local-newer", {
      recurrence: ["RRULE:FREQ=WEEKLY", "EXDATE;VALUE=DATE:20260909"],
    })], nextSyncToken: NEXT_SYNC_TOKEN }],
  });

  await pullCalendar(calendar({ is_writable: true }), deps);

  const change = calls(deps, "apply")[0][2][0];
  assert.equal(change.kind, "read_only");
  assert.equal(deps.records.get("complex-local-newer").familyEvent.title, "Keep local safely");
  assert.equal(deps.records.get("complex-local-newer").mapping.sync_state, "read_only");
  assert.equal(deps.queued.get("family-complex-local-newer"), "superseded");
});

test("duplicate Google IDs within one page use one scoped import", async () => {
  const { pullCalendar } = await pullWorker;
  const duplicate = googleEvent("same-page", { summary: "One remote event" });
  const deps = fakePullDeps({ pages: [
    { items: [duplicate, duplicate], nextSyncToken: NEXT_SYNC_TOKEN },
  ] });

  await pullCalendar(calendar(), deps);

  assert.equal(deps.records.size, 1);
  assert.equal(deps.records.get("same-page").familyEvent.title, "One remote event");
  assert.equal(calls(deps, "apply").length, 1);
});

test("cancellation replay records both baselines and finalizes only with token completion", async () => {
  const { pullCalendar } = await pullWorker;
  const cancelled = googleEvent("cancel-replay", { status: "cancelled" });
  const deps = fakePullDeps({
    records: [mappedRecord("cancel-replay")],
    pages: [
      { items: [cancelled], nextPageToken: "failed-page" },
      Object.assign(new Error("later page failed"), { status: 503 }),
    ],
  });

  await assert.rejects(() => pullCalendar(calendar({ is_writable: true }), deps));

  const pending = deps.records.get("cancel-replay");
  assert.ok(pending.familyEvent.sync_deleted_at, "the confirmed cancellation is hidden pending finalization");
  assert.equal(pending.mapping.last_google_updated_at, cancelled.updated);
  assert.equal(pending.mapping.last_family_updated_at, pending.syncRelevantFamilyUpdatedAt);
  assert.deepEqual(deps.deleted, []);
  deps.enqueuePages({ items: [cancelled], nextSyncToken: NEXT_SYNC_TOKEN });

  await pullCalendar(calendar({ is_writable: true }), deps);

  assert.deepEqual(calls(deps, "apply").map((entry) => entry[2][0].kind), ["cancel", "cancel"]);
  assert.deepEqual(deps.deleted, ["cancel-replay"]);
  assert.equal(deps.records.has("cancel-replay"), false);
});

test("controlled cancellation finalization preserves a Family edit made after page apply", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({
    records: [mappedRecord("cancel-finalize-guard")],
    pages: [{ items: [googleEvent("cancel-finalize-guard", { status: "cancelled" })], nextSyncToken: NEXT_SYNC_TOKEN }],
  });
  const complete = deps.store.completeIncrementalPull;
  deps.store.completeIncrementalPull = async (...args) => {
    const live = deps.records.get("cancel-finalize-guard");
    live.familyEvent.title = "Concurrent Family recovery";
    live.familyEvent.updated_at = "2026-08-27T14:02:00.000Z";
    live.syncRelevantFamilyUpdatedAt = "2026-08-27T14:02:00.000Z";
    return await complete(...args);
  };

  await pullCalendar(calendar({ is_writable: true }), deps);

  const retained = deps.records.get("cancel-finalize-guard");
  assert.equal(retained.familyEvent.title, "Concurrent Family recovery");
  assert.equal(retained.familyEvent.sync_deleted_at, null);
  assert.equal(retained.mapping.sync_state, "needs_attention");
  assert.deepEqual(deps.deleted, []);
  assert.equal(deps.state.syncToken, NEXT_SYNC_TOKEN);
});

test("full reconciliation retains mappings created or modified after its candidate snapshot", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({
    records: [mappedRecord("seen"), mappedRecord("untouched"), mappedRecord("changed")],
    pages: [
      { items: [googleEvent("seen")], nextPageToken: "page-2" },
      { items: [], nextSyncToken: "full-token" },
    ],
  });
  let releaseSecondPage;
  const list = deps.google.list;
  deps.google.list = async (...args) => {
    if (calls(deps, "list").length === 1) {
      return await new Promise((resolve) => { releaseSecondPage = () => resolve(list(...args)); });
    }
    return await list(...args);
  };

  const pulling = pullCalendar(calendar({ sync_token: null }), deps);
  await new Promise((resolve) => setImmediate(resolve));
  deps.records.set("created-during-scan", mappedRecord("created-during-scan", {
    mapping: { created_at: "2026-08-27T14:00:09.000Z" },
  }));
  deps.records.get("changed").familyEvent.updated_at = "family-changed-concurrently";
  releaseSecondPage();
  await pulling;

  assert.deepEqual(deps.deleted, ["untouched"]);
  assert.equal(deps.records.has("changed"), true);
  assert.equal(deps.records.has("created-during-scan"), true);
});

test("a failed full page rolls back its seen markers and releases the scan lease", async () => {
  const { pullCalendar } = await pullWorker;
  const deps = fakePullDeps({
    records: [mappedRecord("stale-full")],
    pages: [{ items: [googleEvent("stale-full")], nextSyncToken: "full-token" }],
  });
  const applyPage = deps.store.applyPage;
  deps.store.applyPage = async (...args) => {
    deps.records.get("stale-full").mapping.updated_at = "mapping-concurrent-change";
    return await applyPage(...args);
  };

  await assert.rejects(() => pullCalendar(calendar({ sync_token: null }), deps));

  assert.equal(deps.records.get("stale-full").familyEvent.title, "Old local title");
  assert.equal(deps.state.activeScan, null);
  assert.equal(calls(deps, "abort-full").length, 1);
  assert.deepEqual(deps.savedSyncTokens, []);
});

test("a stale change rolls back earlier event and queue work from the same page", async () => {
  const { pullCalendar } = await pullWorker;
  const familyWinner = mappedRecord("queue-first", {
    familyEvent: { title: "Local wins", updated_at: "2026-08-27T16:00:00.000Z" },
    syncRelevantFamilyUpdatedAt: "2026-08-27T16:00:00.000Z",
  });
  const stale = mappedRecord("stale-second");
  const deps = fakePullDeps({
    records: [familyWinner, stale],
    pages: [{ items: [
      googleEvent("queue-first", { summary: "Remote loses" }),
      googleEvent("stale-second", { summary: "Must not apply" }),
    ], nextSyncToken: "full-token" }],
  });
  const applyPage = deps.store.applyPage;
  deps.store.applyPage = async (...args) => {
    deps.records.get("stale-second").mapping.updated_at = "concurrent-mapping-version";
    return await applyPage(...args);
  };

  await assert.rejects(() => pullCalendar(calendar({ sync_token: null, is_writable: true }), deps));

  assert.equal(deps.records.get("stale-second").familyEvent.title, "Old local title");
  assert.equal(deps.queued.has("family-queue-first"), false,
    "queue coordination is part of the same page transaction");
  assert.deepEqual(deps.savedSyncTokens, []);
});

test("concurrent incremental pulls cannot regress the saved sync token", async () => {
  const { pullCalendar } = await pullWorker;
  let releaseOlder;
  const olderPage = new Promise((resolve) => { releaseOlder = resolve; });
  const deps = fakePullDeps({ pages: [
    olderPage,
    { items: [], nextSyncToken: "newer-winner-token" },
  ] });

  const olderPull = pullCalendar(calendar(), deps);
  await new Promise((resolve) => setImmediate(resolve));
  const newerPull = pullCalendar(calendar(), deps);
  await newerPull;
  releaseOlder({ items: [], nextSyncToken: "older-loser-token" });

  await assert.rejects(() => olderPull, (error) => {
    assert.equal(error.category, "transient");
    return true;
  });
  assert.equal(deps.state.syncToken, "newer-winner-token");
  assert.deepEqual(deps.savedSyncTokens, ["newer-winner-token"]);
});

test("a 403 quota reason is retryable while an ACL denial remains permission", async () => {
  const { pullCalendar } = await pullWorker;
  for (const scenario of [
    { reason: "rateLimitExceeded", category: "rate_limit", message: "Google Calendar is temporarily busy" },
    { reason: "forbidden", category: "permission", message: "Google calendar is not available for synchronization" },
  ]) {
    const deps = fakePullDeps({ pages: [Object.assign(new Error("private 403 detail"), {
      status: 403,
      reason: scenario.reason,
    })] });
    await assert.rejects(() => pullCalendar(calendar(), deps), (error) => {
      assert.equal(error.category, scenario.category);
      assert.equal(error.message, scenario.message);
      return true;
    });
  }
});

test("the production Google adapter preserves a sanitized 403 quota classification", async () => {
  const { createGooglePullAdapter, pullCalendar } = await pullWorker;
  const { encryptToken } = await tokenCrypto;
  const selected = calendar({ connection: {
    access_token_encrypted: await encryptToken("active-access", TEST_KEY),
    refresh_token_encrypted: await encryptToken("active-refresh", TEST_KEY),
    token_expires_at: "2099-01-01T00:00:00.000Z",
  } });
  const google = createGooglePullAdapter({
    env: (name) => ({
      GOOGLE_TOKEN_ENCRYPTION_KEY: TEST_KEY,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    })[name],
    fetch: async () => Response.json({
      error: { errors: [{ reason: "rateLimitExceeded", message: "private quota project detail" }] },
    }, { status: 403 }),
  });
  const deps = fakePullDeps({ google });

  await assert.rejects(() => pullCalendar(selected, deps), (error) => {
    assert.equal(error.category, "rate_limit");
    assert.equal(error.message, "Google Calendar is temporarily busy");
    assert.doesNotMatch(String(error), /private|project/i);
    return true;
  });
});

test("the real Google adapter sends the incremental events.list contract", async () => {
  const { createGooglePullAdapter, pullCalendar } = await pullWorker;
  const { encryptToken } = await tokenCrypto;
  const requests = [];
  const selected = calendar({ connection: {
    access_token_encrypted: await encryptToken("active-access", TEST_KEY),
    refresh_token_encrypted: await encryptToken("active-refresh", TEST_KEY),
    token_expires_at: "2099-01-01T00:00:00.000Z",
  } });
  const google = createGooglePullAdapter({
    env: (name) => ({
      GOOGLE_TOKEN_ENCRYPTION_KEY: TEST_KEY,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    })[name],
    fetch: async (input) => {
      requests.push(input);
      return Response.json({ items: [], nextSyncToken: NEXT_SYNC_TOKEN });
    },
  });
  const deps = fakePullDeps({ google });

  await pullCalendar(selected, deps);

  assert.equal(requests.length, 1);
  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(request.method, "GET");
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/calendar/v3/calendars/family%40group.calendar.google.com/events");
  assert.equal(url.searchParams.get("singleEvents"), "false");
  assert.equal(url.searchParams.get("showDeleted"), "true");
  assert.equal(url.searchParams.get("syncToken"), SYNC_TOKEN);
  assert.equal(request.headers.get("Authorization"), "Bearer active-access");
});
