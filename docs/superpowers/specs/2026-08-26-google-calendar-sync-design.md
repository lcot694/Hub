# Google Calendar Synchronization Design

## Purpose

Add secure, reliable two-way Google Calendar synchronization to Family Hub without disrupting its existing authentication, household joining, people, calendar views, event editing and deletion, Supabase realtime updates, or service-worker cache behavior.

Family Hub remains the household-facing calendar. Each adult connects their own Google account and chooses which calendars to expose to the household. Children do not need Google accounts. Family Hub person assignment and colour are local metadata and never modify Google.

## Scope

The first release synchronizes event title, date, start and end time, all-day status, simple recurrence, and deletion. It supports simple daily, weekly, monthly, and yearly recurring series.

The first release excludes attendee and invitation management, Google Meet management, moving an existing event between different adults' Google accounts, and edited individual occurrences or other complex recurrence rules.

## Existing Application

The current application is a static GitHub Pages PWA. Browser JavaScript authenticates with Supabase and accesses households, household memberships, people, and events under Row Level Security. Events and people update through Supabase Realtime. The service worker provides shell caching.

The repository has no package manager or automated test suite. `schema.sql` reflects the schema used by the current application; `supabase-setup.sql` represents an older schema generation. Google synchronization will therefore use additive, versioned migrations rather than modifying or rerunning either setup script against an existing database.

## Architecture

The browser continues using Supabase for Family Hub data. It never receives Google access or refresh tokens and never calls Google Calendar directly.

Supabase provides the server-side synchronization boundary:

- OAuth Edge Functions initiate authorization, handle the callback, refresh authorization, and disconnect an account.
- Calendar-management Edge Functions list available Google calendars and save the adult's enabled selections.
- Synchronization Edge Functions pull incremental Google changes, process queued Family Hub changes, reconcile conflicts, and retry failures.
- A scheduled Supabase job invokes synchronization every few minutes.
- Opening Family Hub requests a refresh, subject to server-side throttling, and adults can also select **Sync now**.

Google credentials are encrypted server-side with a deployment secret. Browser-accessible queries and realtime publications cannot expose token ciphertext, refresh tokens, client secrets, or encryption material.

## Identity and Ownership

Each Google connection belongs to one authenticated adult user. During connection, the adult selects an existing Family Hub person profile. The association is stored on the connection and supplies the initial person assignment for newly imported events.

Changing an imported event's person assignment, including assigning it to a child, affects only Family Hub. It does not change the Google organizer, owner, calendar, attendees, colour, or event metadata.

An adult may manage only their own Google connection and calendar selections. Existing household membership rules continue to determine who can see household events. Server-side functions independently verify the caller's user identity, household membership, connection ownership, and calendar permission before each privileged operation.

## Household Time Zone

Households gain an IANA time-zone setting, initially defaulting to `America/Toronto`. Timed Google events are normalized for storage and displayed in the household time zone. All-day events remain date-only values and are never converted through midnight or shifted to another date.

Google recurrence rules retain their source time zone where required to preserve wall-clock behavior through daylight-saving changes. Unsupported recurrence patterns remain visible but are treated as read-only until they can be represented safely.

## Data Model

Additive migrations introduce the following logical records. Exact SQL names may follow established repository naming conventions in the implementation plan.

### Household settings

- Household time zone.

### Google connections

- Authenticated user and household.
- Selected Family Hub person.
- Google account identifier and display email where permitted.
- Encrypted refresh/access credential material and expiry metadata.
- Connection state, last error, and reconnect requirement.
- Created, updated, and disconnected timestamps.

### Google calendar selections

- Connection and Google calendar identifier.
- Display name and Google time zone.
- Enabled state.
- Google access role and derived writable flag.
- Incremental sync token and last successful synchronization timestamp.

### Event mappings

- Family Hub event, connection, selected calendar, and Google event identifier.
- Google recurrence-series identifier when applicable.
- Last observed Google modification timestamp and ETag.
- Last successfully synchronized Family Hub version/timestamp.
- Sync state and safe user-facing error summary.

Each active mapping is unique for its Google connection, calendar, and Google event identifier. This provides idempotency and prevents repeated pulls from creating duplicates.

### Sync queue

- Idempotency key and operation type: create, update, or delete.
- Family Hub event and mapping references.
- Attempt count, next-attempt time, processing lease, and terminal/retryable state.
- Structured internal error category plus a sanitized user-facing message.

Only the latest unprocessed operation for an event is actionable. Newer edits supersede older queued updates while preserving a pending delete.

### Event extensions

Family Hub events gain fields needed for all-day behavior, monthly/yearly recurrence, local modification tracking, and pending deletion. Google-specific identity remains in mapping records rather than being embedded directly into the shared event model.

## Google-to-Family-Hub Flow

1. The synchronizer requests changes using the calendar's saved Google sync token.
2. If Google invalidates a sync token, the function performs a safe full reconciliation for that calendar instead of deleting unmatched local data blindly.
3. A new supported Google event creates a Family Hub event and mapping in one database transaction. The connected adult's selected person is assigned initially.
4. An existing mapping updates the corresponding Family Hub event rather than inserting a duplicate.
5. Google cancellations enter pending deletion and reconciliation logic.
6. The next sync token is committed only after the entire response page sequence succeeds.

Unsupported complex recurring events may be imported for display when they can be represented without data loss, but their Google-owned fields remain read-only. The UI explains why editing is unavailable.

## Family-Hub-to-Google Flow

A new Family Hub event can remain Family-Hub-only or target one enabled writable calendar belonging to the signed-in adult's Google connection.

Saving a Google-backed event commits the Family Hub change first and enqueues a synchronization operation in the same transaction. The UI immediately shows **Syncing**. A worker creates or updates the Google event using an idempotent mapping strategy, then marks the mapping **Synced**.

Only title, date, start/end time, all-day status, supported recurrence, and deletion are sent to Google. Person assignment and colour are excluded from Google payloads.

An existing event cannot be moved to a calendar owned by a different Google account in the first release. A read-only calendar cannot be selected as a destination, and Google-owned fields on its imported events cannot be edited in Family Hub.

## Conflict Resolution

Most-recent-change wins. Conflict comparison uses authoritative server-side Family Hub modification timestamps and Google's `updated` timestamp, never the browser clock.

The mapping stores the versions observed at the last successful synchronization. If only one side changed, that side wins. If both changed, the later authoritative modification timestamp wins. For an exact timestamp tie, Google wins deterministically so repeated reconciliation reaches the same result.

Family-Hub-only metadata is not part of conflict comparison and is never overwritten by Google.

## Deletion

Deleting a Google-backed event requires a clear delete-everywhere warning. After confirmation, the Family Hub event becomes pending deletion and is hidden from normal calendar views while its delete operation is queued. The underlying record and mapping remain until Google confirms deletion.

If Google deletion fails temporarily, the event is recoverable and shows **Needs attention** in the appropriate management surface. After Google confirms deletion or reports the event already absent, the server finalizes the local deletion.

Google-originated cancellations use the same controlled reconciliation path. A temporary Google error never causes Family Hub to discard local event data.

## User Experience

Family settings gain a Google Calendar section where an adult can:

- Connect or reconnect their own Google account.
- Choose the existing Family Hub person representing them.
- Enable and disable calendars.
- See read/write permission for each calendar.
- Request **Sync now**.
- Disconnect their Google account.

Event forms gain a calendar destination selector containing **Family Hub only** and the signed-in adult's enabled writable Google calendars. Imported events identify their source calendar. Their Family Hub person assignment remains independently editable.

Google-backed events show one concise state:

- **Synced**
- **Syncing**
- **Needs attention**
- **Read only**

**Needs attention** provides a sanitized error summary and retry action. Revoked authorization shows **Reconnect Google Calendar**. Repeated transient failures use increasing retry delays while retaining manual retry.

Disconnecting requires the adult to choose whether imported events remain as Family-Hub-only copies or are removed from Family Hub. Disconnecting never deletes events from Google. Removing Family Hub copies during disconnect is distinct from an explicit delete-everywhere action.

## Reliability and Security

- Queue processing uses leases so concurrent workers cannot process the same operation simultaneously.
- Google creates use stable idempotency identifiers and mapping uniqueness to prevent duplicates after ambiguous network failures.
- Retries use bounded exponential backoff with jitter and distinguish transient, authorization, permission, validation, and permanent errors.
- Logs omit credential material and minimize personal event data.
- Error messages returned to the browser are sanitized.
- OAuth uses state validation tied to the authenticated user and a short-lived server-side flow record.
- Redirect destinations are allowlisted.
- Row Level Security protects user-visible metadata; token operations occur only in trusted server functions.
- Service-role credentials, Google client secrets, and encryption keys remain deployment secrets and are never committed.

## Testing

The first implementation stage adds a lightweight JavaScript test setup. Pure synchronization logic is separated from network and database adapters so it can be tested without real credentials.

Automated tests cover:

- Timed and all-day conversion across time zones and daylight-saving boundaries.
- Daily, weekly, monthly, and yearly recurrence translation.
- Rejection or read-only treatment of complex recurrence exceptions.
- Conflict resolution, including deterministic ties.
- Queue supersession, retry delays, leases, and idempotency.
- Duplicate prevention during replay and ambiguous Google responses.
- Pending deletion, failure recovery, and already-absent Google events.
- Read-only calendar enforcement.
- User, household, connection, and calendar authorization boundaries.
- Credential encryption interfaces using non-production test secrets.
- Existing local event creation, editing, deletion, recurrence expansion, realtime refresh, and service-worker cache versioning.

Google API integration tests use mocked HTTP responses. No real credentials or production calendar data are committed.

## Rollout

1. Add the test harness and characterize existing behavior.
2. Apply additive database migrations and security policies in a non-production Supabase environment.
3. Deploy OAuth, calendar-management, queue, and synchronization Edge Functions.
4. Add connection and calendar-selection UI.
5. Add event destination, mapping status, retry, and deletion UI.
6. Configure scheduled synchronization every few minutes.
7. Test with one adult and one dedicated Google test calendar.
8. Verify create, edit, all-day, recurrence, conflict, deletion, reconnect, read-only, duplicate-prevention, and retry scenarios.
9. Enable broader household use only after the controlled test passes.

Google synchronization is opt-in. Existing Family Hub functionality remains usable when no Google account is connected or when the Google service is unavailable. The service-worker cache version is deliberately incremented when browser assets change so deployed clients receive the new behavior.

## Acceptance Criteria

- Each adult can independently connect, select a Family Hub person, and enable their own Google calendars.
- Tokens and secrets never reach browser-accessible storage or repository files.
- Enabled Google events appear without duplicates and default to the connected adult's person.
- Family Hub person and colour changes never modify Google.
- Supported event fields and simple recurrence synchronize in both directions.
- New events can be Family-Hub-only or target an enabled writable Google calendar.
- Read-only Google calendars are displayed without offering prohibited edits.
- Most-recent-change conflict handling converges deterministically.
- Deletion requires explicit warning and remains recoverable until Google confirms.
- Scheduled synchronization, app-open refresh, manual sync, retry, and reconnect behavior work as designed.
- Existing authentication, household, people, calendar views, event editing/deletion, realtime, and cache-busting behavior remain functional.
