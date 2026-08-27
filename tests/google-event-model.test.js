import test from "node:test";
import assert from "node:assert/strict";
import { familyToGoogleEvent, googleToFamilyEvent } from "../lib/google-event-model.js";

const context = {
  householdId:"h1",
  defaultPersonId:"p1",
  householdTimeZone:"America/Toronto"
};

test("all-day Google dates remain date-only", () => {
  const result = googleToFamilyEvent(
    { id:"g1", summary:"School", start:{ date:"2026-09-01" }, end:{ date:"2026-09-02" }, updated:"2026-08-26T12:00:00Z" },
    context
  );

  assert.equal(result.supported, true);
  assert.equal(result.event.event_date, "2026-09-01");
  assert.equal(result.event.all_day, true);
  assert.equal(result.event.start_time, null);
  assert.equal(result.event.end_time, null);
});

test("timed Google events use the household zone across a daylight-saving boundary", () => {
  const result = googleToFamilyEvent({
    id:"g1",
    summary:"After school",
    start:{ dateTime:"2026-03-08T22:30:00Z" },
    end:{ dateTime:"2026-03-08T23:30:00Z" }
  }, context);

  assert.deepEqual(result, {
    supported:true,
    event:{
      household_id:"h1",
      person_id:"p1",
      title:"After school",
      event_date:"2026-03-08",
      start_time:"18:30",
      end_time:"19:30",
      all_day:false,
      recurrence:"none",
      recurrence_end:null
    }
  });
});

test("Family Hub metadata is absent from Google payloads", () => {
  const payload = familyToGoogleEvent({
    title:"Practice", event_date:"2026-09-02", start_time:"18:00", end_time:"19:00",
    all_day:false, recurrence:"weekly", recurrence_end:"2026-12-01", person_id:"child", color:"#fff"
  }, context);

  assert.equal(payload.summary, "Practice");
  assert.equal("person_id" in payload, false);
  assert.equal("color" in payload, false);
  assert.deepEqual(payload.recurrence, ["RRULE:FREQ=WEEKLY;UNTIL=20261202T045959Z"]);
  assert.deepEqual(payload.start, { dateTime:"2026-09-02T18:00:00", timeZone:"America/Toronto" });
  assert.deepEqual(payload.end, { dateTime:"2026-09-02T19:00:00", timeZone:"America/Toronto" });
});

test("all-day Family Hub payloads use an exclusive next date without changing the start date", () => {
  const payload = familyToGoogleEvent({
    title:"Holiday", event_date:"2026-12-31", all_day:true, recurrence:"none"
  }, context);

  assert.deepEqual(payload, {
    summary:"Holiday",
    start:{ date:"2026-12-31" },
    end:{ date:"2027-01-01" }
  });
});

test("simple Google recurrence is translated to Family Hub fields", () => {
  const result = googleToFamilyEvent({
    id:"g3", summary:"Bills", start:{ date:"2026-01-31" }, end:{ date:"2026-02-01" },
    recurrence:["RRULE:FREQ=MONTHLY;INTERVAL=1;UNTIL=20261231"]
  }, context);

  assert.equal(result.supported, true);
  assert.equal(result.event.recurrence, "monthly");
  assert.equal(result.event.recurrence_end, "2026-12-31");
});

test("complex recurrence exceptions are read-only", () => {
  const result = googleToFamilyEvent({
    id:"g2", recurringEventId:"series", originalStartTime:{ dateTime:"2026-09-03T18:00:00-04:00" }
  }, context);

  assert.equal(result.supported, false);
  assert.equal(result.readOnlyReason, "complex_recurrence_exception");
});

test("multiple recurrence rules and positional rules are read-only", () => {
  const multiple = googleToFamilyEvent({
    id:"g4", start:{ date:"2026-09-01" }, end:{ date:"2026-09-02" },
    recurrence:["RRULE:FREQ=WEEKLY", "EXDATE;VALUE=DATE:20260908"]
  }, context);
  const positional = googleToFamilyEvent({
    id:"g5", start:{ date:"2026-09-01" }, end:{ date:"2026-09-02" },
    recurrence:["RRULE:FREQ=MONTHLY;BYSETPOS=1"]
  }, context);

  assert.deepEqual(multiple, { supported:false, readOnlyReason:"complex_recurrence" });
  assert.deepEqual(positional, { supported:false, readOnlyReason:"complex_recurrence" });
});
