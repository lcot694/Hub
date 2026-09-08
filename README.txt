FAMILY HUB V3 — SHARED FAMILY CALENDAR WITH GOOGLE SYNC

OVERVIEW
Family Hub is an installable web app backed by Supabase. Version 3 adds optional,
secure two-way Google Calendar sync. Google credentials and tokens stay in
server-side Supabase Edge Functions. The browser receives only the Supabase
project URL and publishable key.

PREREQUISITES
- A Supabase project with Database, Auth, Edge Functions, Vault, pg_cron, and
  pg_net available.
- An HTTPS URL hosting this folder.
- A Google Cloud project with the Google Calendar API enabled.
- Google OAuth 2.0 Web application credentials. Add this exact authorized
  redirect URI, substituting your Supabase project URL:
  https://YOUR_PROJECT.supabase.co/functions/v1/google-oauth-callback
- Configure the OAuth consent screen and allowed users for your environment.

PUBLIC BROWSER CONFIGURATION
Edit config.js and set only:
- SUPABASE_URL: the project URL.
- SUPABASE_PUBLISHABLE_KEY: the publishable key (or legacy anon key).

Never place a service-role key, Google credential, OAuth token, encryption key,
cron credential, or Vault value in config.js or any hosted browser file.

SERVER SECRETS
Configure all eight required values and the optional return-path setting as Supabase Edge Function secrets. Enter deployment values
in the Supabase dashboard or CLI; do not commit or paste their values into docs.
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_OAUTH_REDIRECT_URI
- GOOGLE_TOKEN_ENCRYPTION_KEY (base64 encoding of exactly 32 random bytes)
- APP_ORIGIN (the exact HTTPS app origin)
- APP_RETURN_PATH (optional hosted app path, for example /Hub/; defaults to /)
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- SYNC_CRON_SECRET (a high-entropy bearer credential)

DATABASE SETUP

FRESH INSTALL
First apply schema.sql once to create the baseline Family Hub database. After
that succeeds, apply every file in supabase/migrations in this exact filename
order:
1. 202608260001_google_sync_schema.sql
2. 202608260002_google_sync_schedule.sql
3. 202608270002_google_calendar_hardening.sql
4. 202608270003_google_event_status_surface.sql
5. 202608270004_google_event_update_guard.sql
6. 202608270005_remove_sync_guc_upgrade.sql
7. 202608270006_google_disconnect.sql
8. 202608270007_google_disconnect_race_hardening.sql
9. 202608270008_google_oauth_generation_serialization.sql
10. 202608270009_google_oauth_consumption_and_reconnect.sql
11. 202609080001_google_sync_final_hardening.sql
12. 202609080002_google_reconnect_failure_fence.sql
13. 202609080003_google_stale_authorization_queue_fix.sql

EXISTING V2 UPGRADE
Do not reapply schema.sql: the baseline already exists. Back up the database,
then apply the same thirteen migration files above in exact filename order. Before
the hardening migration, inspect google_connections for duplicate user_id
values. That migration stops with google_connection_duplicate_users instead of
choosing which account and dependent rows to remove. Review and explicitly
disconnect the unwanted connection, then retry the remaining migrations.

EDGE FUNCTIONS
Deploy all six function directories under supabase/functions:
- google-oauth-start
- google-oauth-callback
- google-calendars
- google-sync
- google-sync-scheduled
- google-disconnect

The URI registered with Google and GOOGLE_OAUTH_REDIRECT_URI must both be the
deployed google-oauth-callback URL shown above. Do not disable JWT verification
globally. `google-oauth-callback` and `google-sync-scheduled` are the only
intentional JWT-verification exceptions in supabase/config.toml. The callback
validates one-time OAuth state. The scheduler cannot present a user JWT because
pg_cron calls it with the custom bearer held in Vault; it validates that bearer
against SYNC_CRON_SECRET with a constant-time comparison. All other
browser-facing functions retain platform JWT verification and authenticate the
caller.

VAULT AND FIVE-MINUTE SCHEDULE
Create these exact Supabase Vault secrets:
- project_url: the Supabase project URL used to call the scheduled function.
- google_sync_cron_secret: the same credential stored as SYNC_CRON_SECRET in
  the Edge Function environment.

Migration 202608260002_google_sync_schedule.sql installs the
family-hub-google-sync job with schedule */5 * * * * (every five minutes). It
reads both values from Vault at execution time; never substitute literal secret
values into the migration. Confirm the cron job and successful pg_net responses
without printing authorization headers.

HOSTING AND INSTALLATION
Host the repository root on HTTPS (for example GitHub Pages, Netlify, or Vercel).
Do not open index.html directly from disk. On a phone or tablet, open the hosted
URL and choose Add to Home screen / Install app. Version 3 uses the
family-hub-v3 shell cache; complete the service-worker refresh check in
docs/google-calendar-rollout-checklist.md after publishing.

ROLLOUT
Use a non-production household, one adult test account, and a dedicated writable
Google test calendar. Complete docs/google-calendar-rollout-checklist.md before
real household use. Record outcomes only—never secrets, tokens, calendar text,
private email addresses, or other private content.

OPERATING NOTES
- Sync runs on app open, on Sync now, and every five minutes.
- Read-only or unsupported Google events remain visible but are not writable.
- Disconnecting never deletes Google events. The user chooses whether imported
  Family Hub copies are kept or removed.
- Offline mode caches the app shell; current shared data and Google sync require
  network access.
- If Google authorization is revoked or expires, reconnect from Family Hub.
- Investigate failures using request IDs and safe categories. Never copy request
  headers or raw private event payloads into tickets, logs, or rollout records.
