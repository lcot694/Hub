import test from "node:test";
import assert from "node:assert/strict";
import { chooseConflictWinner, retryDecision } from "../lib/sync-policy.js";

test("Google wins an exact conflict timestamp tie", () => {
  const time = "2026-08-26T12:00:00.000Z";
  assert.equal(chooseConflictWinner(
    { last_family_updated_at:"2026-08-25T00:00:00Z", last_google_updated_at:"2026-08-25T00:00:00Z" },
    { updated_at:time }, { updated:time }
  ), "google");
});

test("conflict policy preserves PostgreSQL microseconds and RFC3339 offsets", () => {
  assert.equal(chooseConflictWinner(
    { last_family_updated_at:"2026-08-26T12:00:00.000000Z", last_google_updated_at:"2026-08-26T12:00:00.000000Z" },
    { updated_at:"2026-08-26T08:00:00.000999-04:00" }, { updated:"2026-08-26T12:00:00.000000Z" }
  ), "family");
});

test("Google wins an exact microsecond timestamp tie", () => {
  assert.equal(chooseConflictWinner(
    { last_family_updated_at:"2026-08-26T12:00:00.000000Z", last_google_updated_at:"2026-08-26T12:00:00.000000Z" },
    { updated_at:"2026-08-26T12:00:00.000999Z" }, { updated:"2026-08-26T08:00:00.000999-04:00" }
  ), "google");
});

test("conflict policy selects only the side changed since the last sync", () => {
  const mapping = {
    last_family_updated_at:"2026-08-25T10:00:00Z",
    last_google_updated_at:"2026-08-25T10:00:00Z"
  };

  assert.equal(chooseConflictWinner(mapping,
    { updated_at:"2026-08-26T10:00:00Z" }, { updated:"2026-08-25T10:00:00Z" }), "family");
  assert.equal(chooseConflictWinner(mapping,
    { updated_at:"2026-08-25T10:00:00Z" }, { updated:"2026-08-26T10:00:00Z" }), "google");
  assert.equal(chooseConflictWinner(mapping,
    { updated_at:"2026-08-25T10:00:00Z" }, { updated:"2026-08-25T10:00:00Z" }), "unchanged");
});

test("later authoritative timestamp wins when both sides changed", () => {
  assert.equal(chooseConflictWinner(
    { last_family_updated_at:"2026-08-25T00:00:00Z", last_google_updated_at:"2026-08-25T00:00:00Z" },
    { updated_at:"2026-08-26T12:00:01Z" }, { updated:"2026-08-26T12:00:00Z" }
  ), "family");
});

test("authorization errors require reconnect without retry", () => {
  assert.deepEqual(retryDecision("authorization", 2, "2026-08-26T12:00:00Z"), {
    retryable:false, nextAttemptAt:null
  });
});

test("transient retries use bounded exponential backoff and injectable jitter", () => {
  assert.deepEqual(retryDecision("transient", 2, "2026-08-26T12:00:00Z", { jitter:() => 7 }), {
    retryable:true, nextAttemptAt:"2026-08-26T12:02:07.000Z"
  });
  assert.deepEqual(retryDecision("rate_limit", 10, "2026-08-26T12:00:00Z", { jitter:() => 0 }), {
    retryable:true, nextAttemptAt:"2026-08-26T13:00:00.000Z"
  });
});

test("normal retry calls use production jitter while tests inject deterministic jitter", () => {
  const random = Math.random;
  Math.random = () => 0.5;
  try {
    assert.deepEqual(retryDecision("transient", 0, "2026-08-26T12:00:00Z"), {
      retryable:true, nextAttemptAt:"2026-08-26T12:00:45.000Z"
    });
  } finally {
    Math.random = random;
  }
});

test("permission, validation, permanent, and unknown errors do not retry", () => {
  for (const category of ["permission", "validation", "permanent", "unknown"]) {
    assert.deepEqual(retryDecision(category, 0, "2026-08-26T12:00:00Z"), {
      retryable:false, nextAttemptAt:null
    });
  }
});
