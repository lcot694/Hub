import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("service worker v3 pre-caches the complete local browser module graph", async () => {
  const source = await readFile(new URL("sw.js", root), "utf8");
  const requiredAssets = [
    "./app.js",
    "./app.js?v=3",
    "./lib/calendar-domain.js",
    "./lib/google-event-model.js",
    "./lib/google-ui.js",
    "./lib/sync-policy.js",
  ];

  assert.match(source, /family-hub-v3/);
  for (const asset of requiredAssets) {
    assert.ok(source.includes(JSON.stringify(asset)), `${asset} must be pre-cached`);
  }
});

test("HTML loads the v3 application entry point", async () => {
  const source = await readFile(new URL("index.html", root), "utf8");
  assert.match(source, /<script\s+type="module"\s+src="app\.js\?v=3"><\/script>/);
});
