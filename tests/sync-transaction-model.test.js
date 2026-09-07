import test from "node:test";
import assert from "node:assert/strict";
import { createSyncTransactionModel } from "./support/sync-transaction-model.js";

test("a stale page CAS rolls back its earlier event, queue, and seen changes", () => {
  const model = createSyncTransactionModel({ version: "v1", mappings: { a: { eventVersion: "e1" } } });
  assert.throws(() => model.applyPage({ version: "v1", changes: [
    { id: "a", expected: "e1", queuePolicy: "ensure_update" },
    { id: "a", expected: "stale", queuePolicy: "supersede_pending" },
  ], seen: ["a"] }), /stale/);
  assert.deepEqual(model.snapshot(), { version: "v1", mappings: { a: { eventVersion: "e1" } }, queue: [], seen: [] });
});

test("duplicate imports are idempotent and never create an orphan event", () => {
  const model = createSyncTransactionModel({ version: "v1" });
  model.applyPage({ version: "v1", changes: [{ kind: "import", id: "g1" }, { kind: "import", id: "g1" }], seen: ["g1"] });
  assert.deepEqual(model.snapshot().events, ["event:g1"]);
  assert.deepEqual(Object.keys(model.snapshot().mappings), ["g1"]);
});

test("cancellation and reconciliation guards preserve concurrent changes", () => {
  const model = createSyncTransactionModel({ version: "v1", mappings: { gone: { eventVersion: "e1" }, changed: { eventVersion: "e1" } } });
  const scan = model.beginFull("v1");
  model.cancel("gone", "e1");
  model.concurrentEdit("changed");
  model.finishFull(scan, { seen: [], nextVersion: "v2" });
  assert.deepEqual(Object.keys(model.snapshot().mappings), ["changed"]);
  assert.equal(model.snapshot().version, "v2");
  assert.throws(() => model.abortFull(scan), /stale/);
});
