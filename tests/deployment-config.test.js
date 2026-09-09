import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("only the OAuth callback and cron-authenticated scheduler bypass platform JWT verification", async () => {
  const config = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");
  const exceptions = [...config.matchAll(/\[functions\.([^\]]+)\]\s*\r?\nverify_jwt\s*=\s*false/g)].map((match) => match[1]);

  assert.deepEqual(exceptions.sort(), ["google-oauth-callback", "google-sync-scheduled"]);
});

test("deployment guide separates fresh baseline setup from ordered existing-v2 upgrades", async () => {
  const readme = await readFile(new URL("../README.txt", import.meta.url), "utf8");
  const fresh = readme.indexOf("FRESH INSTALL");
  const baseline = readme.indexOf("schema.sql", fresh);
  const migrations = readme.indexOf("202608260001_google_sync_schema.sql", baseline);
  const upgrade = readme.indexOf("EXISTING V2 UPGRADE");

  assert.ok(fresh >= 0 && baseline > fresh && migrations > baseline);
  assert.ok(upgrade > migrations);
  assert.match(readme, /google-oauth-callback[\s\S]*google-sync-scheduled[\s\S]*intentional JWT-verification exceptions/i);
});
