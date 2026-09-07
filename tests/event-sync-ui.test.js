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
  assert.match(source, /rpc\("get_google_sync_status"\)/);
  assert.match(source, /rpc\(plan\.functionName,plan\.args\)/);
  assert.match(source, /rpc\("request_google_event_delete",\{p_family_event_id:/);
  assert.match(source, /from\("events"\)\.update\(\{person_id:/);
  assert.match(source, /googleSettings\.requestSync\("manual"\)/);
  assert.doesNotMatch(source, /eventSyncStatus[^\n]*innerHTML/);
});
