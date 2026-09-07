import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FAMILY_HUB_ONLY,
  visibleEvents,
  syncPresentation,
  editPermissions,
  googleDeleteWarning,
  eventWritePlan,
  buildEventSyncIndex,
  createOperationGuard,
} from "../lib/google-ui.js";

test("pending Google deletions are hidden from every calendar view", () => {
  assert.deepEqual(visibleEvents([
    { id: "visible", sync_deleted_at: null },
    { id: "pending", sync_deleted_at: "2026-08-26T12:00:00Z" },
  ]).map(({ id }) => id), ["visible"]);
});

test("mapping states have concise accessible labels and retry only for attention", () => {
  assert.deepEqual(syncPresentation({ sync_state: "synced" }), { label: "Synced", retryable: false });
  assert.deepEqual(syncPresentation({ sync_state: "syncing" }), { label: "Syncing", retryable: false });
  assert.deepEqual(syncPresentation({ sync_state: "needs_attention" }), { label: "Needs attention", retryable: true });
  assert.deepEqual(syncPresentation({ sync_state: "read_only" }), { label: "Read only", retryable: false });
  assert.equal(syncPresentation(null), null);
});

test("read-only Google events permit only local person reassignment", () => {
  assert.deepEqual(editPermissions({ writable: false }), {
    title: false, date: false, times: false, recurrence: false, person: true, deleteEverywhere: false,
  });
  assert.deepEqual(editPermissions({ sync_state: "synced", calendar_writable: true }), {
    title: true, date: true, times: true, recurrence: true, person: true, deleteEverywhere: true,
  });
});

test("another adult's mapping disables every direct mutation", () => {
  assert.deepEqual(editPermissions({ mapping_owned: false, sync_state: "synced", calendar_writable: true }), {
    title: false, date: false, times: false, recurrence: false, person: false, deleteEverywhere: false,
  });
});

test("failed optional status loading preserves events with conservative unknown mappings", () => {
  const events = [{ id: "local-or-mapped" }, { id: "second" }];
  const index = buildEventSyncIndex(events, null, new Error("offline"), "adult-a");
  assert.equal(index.known, false);
  assert.equal(index.byEvent.get("local-or-mapped").uncertain, true);
  assert.deepEqual(editPermissions(index.byEvent.get("local-or-mapped")), {
    title: false, date: false, times: false, recurrence: false, person: false, deleteEverywhere: false,
  });
});

test("successful household status distinguishes own and other-adult mappings", () => {
  const events = [{ id: "own" }, { id: "other" }, { id: "local" }];
  const index = buildEventSyncIndex(events, [
    { family_event_id: "own", owner_user_id: "adult-a", sync_state: "synced", calendar_writable: true },
    { family_event_id: "other", owner_user_id: "adult-b", sync_state: "synced", calendar_writable: true },
  ], null, "adult-a");
  assert.equal(index.known, true);
  assert.equal(index.byEvent.get("own").mapping_owned, true);
  assert.equal(index.byEvent.get("other").mapping_owned, false);
  assert.equal(index.byEvent.has("local"), false);
});

test("invalidating an async dialog operation restores controls without letting stale cleanup affect a new operation", () => {
  const guard = createOperationGuard();
  const button = { disabled: false };
  const old = guard.begin(button);
  guard.invalidate();
  assert.equal(button.disabled, false);
  const current = guard.begin(button);
  guard.finish(old);
  assert.equal(button.disabled, true);
  assert.equal(guard.isCurrent(old), false);
  assert.equal(guard.isCurrent(current), true);
  guard.finish(current);
  assert.equal(button.disabled, false);
});

test("Google deletion warning names the external calendar exactly", () => {
  assert.equal(
    googleDeleteWarning({ title: "Dentist", calendarName: "School <Calendar>" }),
    'Delete "Dentist" from Family Hub and Google Calendar “School <Calendar>”? This deletes it everywhere.',
  );
});

test("write plan preserves direct Family writes and routes Google writes through the atomic RPC", () => {
  const payload = { id: "event", household_id: "household", title: "Dentist" };
  assert.deepEqual(eventWritePlan(payload, FAMILY_HUB_ONLY, false), {
    kind: "family-insert", payload,
  });
  assert.deepEqual(eventWritePlan(payload, FAMILY_HUB_ONLY, true), {
    kind: "family-update", payload,
  });
  assert.deepEqual(eventWritePlan(payload, "calendar-row", true), {
    kind: "google-rpc", functionName: "save_google_backed_event",
    args: { p_event: { ...payload, google_calendar_id: "calendar-row" } },
  });
});

test("event form exposes all-day, destination, monthly and yearly controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="eventAllDay"/);
  assert.match(html, /id="eventCalendar"/);
  assert.match(html, /option value="monthly"/);
  assert.match(html, /option value="yearly"/);
  assert.match(html, /id="eventSyncStatus"[^>]*aria-live="polite"/);
});

test("app uses status RPC, atomic Google writes, pending deletion RPC, and local-only read-only edits", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /rpc\("get_google_sync_status",\{p_household_id:household\.id\}\)/);
  assert.match(source, /rpc\(plan\.functionName,plan\.args\)/);
  assert.match(source, /rpc\("request_google_event_delete",\{p_family_event_id:/);
  assert.match(source, /from\("events"\)\.update\(\{person_id:/);
  assert.match(source, /googleSettings\.requestSync\("manual"\)/);
  assert.match(source, /google_event_sync_status/);
  assert.doesNotMatch(source, /eventSyncStatus[^\n]*innerHTML/);
});
