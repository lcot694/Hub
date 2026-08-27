import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const handler = (name) => new URL(`../supabase/functions/${name}/index.ts`, import.meta.url);

async function source(name) {
  return readFile(handler(name), "utf8");
}

test("OAuth start authenticates and verifies the selected household and person", async () => {
  const start = await source("google-oauth-start");

  assert.match(start, /authenticate\s*=\s*dependencies\.authenticate\s*\?\?\s*requireUser/);
  assert.match(start, /from\(\s*["']household_members["']\s*\)/);
  assert.match(start, /eq\(\s*["']user_id["']\s*,\s*userId\s*\)/);
  assert.match(start, /from\(\s*["']people["']\s*\)/);
  assert.match(start, /eq\(\s*["']household_id["']\s*,\s*householdId\s*\)/);
  assert.match(start, /eq\(\s*["']id["']\s*,\s*personId\s*\)/);
});

test("OAuth start uses random hashed state, PKCE S256, and a ten-minute flow", async () => {
  const start = await source("google-oauth-start");

  assert.match(start, /crypto\.getRandomValues/);
  assert.match(start, /crypto\.subtle\.digest\(\s*["']SHA-256["']/);
  assert.match(start, /state_hash:\s*stateHash/);
  assert.match(start, /pkceVerifier/);
  assert.match(start, /10\s*\*\s*60\s*\*\s*1000/);
  assert.match(start, /code_challenge_method["']?\s*,\s*["']S256["']/);
  assert.doesNotMatch(start, /state_hash:\s*state(?:\s*[,}])/);
});

test("OAuth authorization request uses the configured callback and required consent contract", async () => {
  const start = await source("google-oauth-start");

  for (const scope of [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ]) assert.match(start, new RegExp(scope.replace(/[./]/g, "\\$&")));

  assert.match(start, /GOOGLE_OAUTH_REDIRECT_URI/);
  assert.match(start, /redirect_uri["']?\s*,\s*redirectUri/);
  assert.match(start, /access_type["']?\s*,\s*["']offline["']/);
  assert.match(start, /prompt["']?\s*,\s*["']consent["']/);
});

test("OAuth callback atomically consumes only a matching unexpired unused state", async () => {
  const callback = await source("google-oauth-callback");

  assert.match(callback, /stateHash\s*=\s*await sha256/);
  assert.match(callback, /from\(\s*["']google_oauth_flows["']\s*\)/);
  assert.match(callback, /update\(\s*\{\s*consumed_at:/);
  assert.match(callback, /eq\(\s*["']state_hash["']\s*,\s*stateHash\s*\)/);
  assert.match(callback, /is\(\s*["']consumed_at["']\s*,\s*null\s*\)/);
  assert.match(callback, /gt\(\s*["']expires_at["']/);
  assert.match(callback, /code_verifier["']?\s*:\s*pkceVerifier/);
});

test("OAuth callback consumes valid state before handling a Google denial", async () => {
  const callback = await source("google-oauth-callback");
  const handlerBody = callback.slice(callback.indexOf("export async function handleOAuthCallback"));

  assert.ok(handlerBody.indexOf("await consumeFlow") >= 0);
  assert.ok(handlerBody.indexOf('searchParams.has("error")') >= 0);
  assert.ok(handlerBody.indexOf("await consumeFlow") < handlerBody.indexOf('searchParams.has("error")'));
});

test("OAuth callback encrypts credentials and upserts the stable Google account identity", async () => {
  const callback = await source("google-oauth-callback");

  assert.match(callback, /https:\/\/openidconnect\.googleapis\.com\/v1\/userinfo/);
  assert.match(callback, /googleAccountId\s*=\s*userinfo\.sub/);
  assert.match(callback, /encrypt\(\s*tokens\.access_token/);
  assert.match(callback, /encrypt\(\s*tokens\.refresh_token/);
  assert.match(callback, /dependencies\.encrypt\s*\?\?\s*encryptToken/);
  assert.match(callback, /from\(\s*["']google_connections["']\s*\)/);
  assert.match(callback, /onConflict:\s*["']user_id,google_account_id["']/);
  assert.doesNotMatch(callback, /access_token:\s*tokens\.access_token/);
  assert.doesNotMatch(callback, /refresh_token:\s*tokens\.refresh_token/);
});

test("OAuth callback redirects only to fixed app paths with sanitized error codes", async () => {
  const callback = await source("google-oauth-callback");

  assert.match(callback, /APP_ORIGIN/);
  assert.match(callback, /google=connected/);
  assert.match(callback, /google=error&code=/);
  assert.match(callback, /SANITIZED_ERROR_CODES/);
  assert.doesNotMatch(callback, /searchParams\.set\(\s*["'](?:access_token|refresh_token|token|jwt)["']/i);
  assert.doesNotMatch(callback, /new URL\(\s*flow\.redirect_path|Location[^\n]*redirect_path/);
});
