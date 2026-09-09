import test from "node:test";
import assert from "node:assert/strict";
import { occursOn, eventsFor, normalizeEventTimes } from "../lib/calendar-domain.js";

test("weekly events occur every seven days through recurrence_end", () => {
  const event = { event_date:"2026-08-03", start_time:"09:00", recurrence:"weekly", recurrence_end:"2026-08-31" };
  assert.equal(occursOn(event, new Date(2026, 7, 10)), true);
  assert.equal(occursOn(event, new Date(2026, 7, 11)), false);
  assert.equal(occursOn(event, new Date(2026, 8, 7)), false);
});

test("eventsFor preserves start-time ordering", () => {
  const events = [
    { id:"late", event_date:"2026-08-26", start_time:"17:00", recurrence:"none" },
    { id:"early", event_date:"2026-08-26", start_time:"08:00", recurrence:"none" }
  ];
  assert.deepEqual(eventsFor(events, new Date(2026, 7, 26)).map(x => x.id), ["early", "late"]);
});

test("monthly recurrence clamps to the final day of shorter months", () => {
  const event = { event_date:"2026-01-31", recurrence:"monthly", recurrence_end:null };
  assert.equal(occursOn(event, new Date(2026, 1, 28)), true);
  assert.equal(occursOn(event, new Date(2026, 2, 31)), true);
});

test("yearly recurrence preserves February 29 semantics", () => {
  const event = { event_date:"2024-02-29", recurrence:"yearly", recurrence_end:null };
  assert.equal(occursOn(event, new Date(2025, 1, 28)), true);
  assert.equal(occursOn(event, new Date(2028, 1, 29)), true);
});

test("all-day normalization removes clock values", () => {
  assert.deepEqual(normalizeEventTimes({ all_day:true, start_time:"09:00", end_time:"10:00" }), {
    all_day:true, start_time:null, end_time:null
  });
});
