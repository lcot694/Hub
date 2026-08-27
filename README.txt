FAMILY HUB V2 — SHARED FAMILY CALENDAR

WHAT THIS VERSION ADDS
- Secure email/password sign-in
- Private household membership
- Six-character family sharing code
- Cloud-synced events across devices
- Live realtime updates
- Day / week / month views
- Family member colors
- Add/remove family members
- Daily and weekly repeating events
- Installable PWA structure for tablet/phone

IMPORTANT
Version 2 needs a free Supabase project because it now stores shared household data online.

SETUP — ABOUT 5 STEPS

1. CREATE A SUPABASE PROJECT
   Go to supabase.com and create a free project.

2. CREATE THE DATABASE
   In Supabase:
   SQL Editor -> New query
   Open schema.sql from this folder.
   Paste the entire contents into the SQL editor.
   Click Run.

3. ADD YOUR APP CONNECTION VALUES
   In Supabase, open Project Settings -> API.

   Copy:
   - Project URL
   - Publishable key (or anon key if your project still labels it that way)

   Open config.js and replace:
   PASTE_YOUR_SUPABASE_URL_HERE
   PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE

   Do NOT use the service_role key. That key must never go in browser code.

4. HOST THE FOLDER
   Because this is now a PWA and uses browser modules, do not just double-click index.html.

   Simplest free choices:
   - Netlify Drop
   - Vercel
   - GitHub Pages

   Upload/publish the contents of this folder, then open the HTTPS address it gives you.

5. CREATE YOUR FAMILY
   - Open the hosted app.
   - Create your login.
   - If Supabase asks you to verify your email, verify it and sign in.
   - Choose "Create household."
   - Rename/add family members as desired.
   - On another phone/tablet, create a separate login and choose "Join household."
   - Enter the six-character family code.

TABLET INSTALL
On Chrome/Samsung Internet:
- Open the hosted Family Hub URL
- Browser menu -> Add to Home screen / Install app
- Launch it from the new icon for a near-native full-screen experience

SECURITY DESIGN
- Every household has its own UUID.
- Users join a household through a database function.
- Row Level Security limits people/events to signed-in household members.
- The browser only receives the Supabase publishable key; that key is intended to be used with RLS.
- Never place your Supabase service_role key in config.js.

CURRENT LIMITATIONS
- Repeating events support daily or weekly repetition only.
- Editing an existing event is not implemented yet; delete/re-create for now.
- The app supports one household per login in the current interface.
- Google Calendar is not connected yet.
- Offline mode caches the app shell, but new/changed cloud data still requires internet.

NEXT BUILD
Version 3 should add:
1. Google Calendar import/sync
2. Edit-event screen
3. Chores/routines and stars
4. Grocery/shared lists
5. Wall-dashboard mode

GOOGLE CALENDAR ROLLOUT NOTE
Before applying the Google Calendar hardening migration to an existing database, inspect
google_connections for duplicate user_id values. The migration stops with
google_connection_duplicate_users rather than deleting or moving calendars, mappings, or
sync jobs. Explicitly disconnect the unwanted connection (after reviewing its attached
rows), then retry the migration. Fresh installs enforce one Google account per login.
