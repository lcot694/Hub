import test from "node:test";
import assert from "node:assert/strict";
import { calendarDestinationOptions } from "../lib/google-ui.js";

test("read-only calendars cannot become event destinations", () => {
  const options = calendarDestinationOptions([
    { id: "family", summary: "Family", enabled: true, writable: true },
    { id: "holidays", summary: "Holidays", enabled: true, writable: false },
    { id: "disabled", summary: "Disabled", enabled: false, writable: true },
  ]);

  assert.deepEqual(options.map((option) => option.value), ["family-hub-only", "family"]);
});
