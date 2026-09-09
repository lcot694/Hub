export function createSyncTransactionModel(initial = {}) {
  let state = {
    version: initial.version,
    mappings: structuredClone(initial.mappings || {}),
    events: structuredClone(initial.events || []),
    queue: [], seen: [], guards: {}, generation: 0, scan: null,
  };
  const snapshot = () => {
    const copy = structuredClone(state);
    delete copy.generation; delete copy.scan;
    if (!copy.events.length) delete copy.events;
    if (!Object.keys(copy.guards).length) delete copy.guards;
    return copy;
  };
  return {
    snapshot,
    applyPage(page) {
      const before = structuredClone(state);
      try {
        if (page.version !== state.version) throw new Error("stale run");
        for (const change of page.changes) {
          if (change.kind === "import") {
            if (!state.mappings[change.id]) {
              state.events.push(`event:${change.id}`);
              state.mappings[change.id] = { eventVersion: "imported" };
            }
            continue;
          }
          if (state.mappings[change.id]?.eventVersion !== change.expected) throw new Error("stale event");
          if (change.queuePolicy === "ensure_update") state.queue.push([change.id, "update"]);
          if (change.queuePolicy === "supersede_pending") state.queue = state.queue.filter(([id]) => id !== change.id);
        }
        state.seen.push(...page.seen.filter(id => !state.seen.includes(id)));
      } catch (error) { state = before; throw error; }
    },
    beginFull(expectedVersion) {
      if (expectedVersion !== state.version) throw new Error("stale run");
      const scan = { generation: ++state.generation, version: state.version, candidates: structuredClone(state.mappings) };
      state.scan = scan;
      return structuredClone(scan);
    },
    cancel(id, expected) {
      if (state.mappings[id]?.eventVersion !== expected) throw new Error("stale cancellation");
      state.mappings[id].cancelGuard = expected;
      state.guards[id] = expected;
    },
    concurrentEdit(id) { state.mappings[id].eventVersion = "concurrent"; },
    finishFull(scan, { seen, cancellations = [], nextVersion }) {
      if (!state.scan || scan.generation !== state.scan.generation || scan.version !== state.version) throw new Error("stale scan");
      for (const [id, candidate] of Object.entries(scan.candidates)) {
        const current = state.mappings[id];
        if (!seen.includes(id) && current?.eventVersion === candidate.eventVersion) {
          delete state.mappings[id]; state.events = state.events.filter(value => value !== `event:${id}`);
        }
      }
      for (const id of cancellations) delete state.guards[id];
      state.version = nextVersion; state.scan = null;
    },
    abortFull(scan) {
      if (!state.scan || scan.generation !== state.scan.generation) throw new Error("stale scan");
      state.scan = null;
    },
  };
}
