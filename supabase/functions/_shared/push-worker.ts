import { familyToGoogleEvent, googleToFamilyEvent } from "../../../lib/google-event-model.js";
import { chooseConflictWinner, retryDecision } from "../../../lib/sync-policy.js";
import {
  googleFetch,
  type GoogleClientDependencies,
  type GoogleConnection,
} from "./google-client.ts";

export type PushOperation = "create" | "update" | "delete";
export type PushErrorCategory =
  | "authorization"
  | "permission"
  | "validation"
  | "rate_limit"
  | "transient"
  | "permanent";

export interface ClaimedPushJob {
  id: string;
  claim_token: string;
  family_event_id: string;
  google_event_mapping_id: string;
  operation: PushOperation;
  attempt_count: number;
}

export interface FamilyPushEvent {
  id: string;
  household_id: string;
  person_id: string | null;
  title: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  all_day: boolean;
  recurrence: string;
  recurrence_end: string | null;
  updated_at: string;
  sync_deleted_at: string | null;
}

export interface PushMapping {
  id: string;
  family_event_id: string;
  google_connection_id: string;
  google_calendar_id: string;
  google_event_id: string;
  google_etag: string | null;
  last_family_updated_at: string | null;
  last_google_updated_at: string | null;
}

export interface PushConnection {
  id: string;
  user_id: string;
  household_id: string;
  connection_state: "active" | "reconnect_required" | "disconnected";
  [key: string]: unknown;
}

export interface PushCalendar {
  id: string;
  google_connection_id: string;
  google_calendar_id: string;
  enabled: boolean;
  is_writable: boolean;
  [key: string]: unknown;
}

export interface PushContext {
  familyEvent: FamilyPushEvent;
  mapping: PushMapping;
  connection: PushConnection;
  calendar: PushCalendar;
  ownerUserId: string;
  householdTimeZone: string;
}

export interface GooglePushEvent {
  id: string;
  status?: string;
  etag: string;
  updated: string;
  [key: string]: unknown;
}

export interface GoogleDeleteResponse {
  status: number;
  event?: GooglePushEvent;
}

export interface PushCompletion {
  finalizeLocalDelete: boolean;
  mapping?: {
    google_event_id: string;
    google_etag: string;
    google_updated_at: string;
    last_family_updated_at?: string;
    last_google_updated_at: string;
    sync_state: "synced";
    safe_error_message: null;
  };
  reconcileGoogleEvent?: GooglePushEvent;
  reconcileFamilyEvent?: Record<string, unknown>;
  /** Atomically copy the reconciled event row's updated_at into the mapping. */
  captureReconciledFamilyUpdatedAt?: true;
}

export interface PushStore {
  loadContext(job: ClaimedPushJob): Promise<PushContext>;
  complete(jobId: string, claimToken: string, completion: PushCompletion): Promise<void>;
  fail(
    jobId: string,
    claimToken: string,
    category: PushErrorCategory,
    safeMessage: string,
    nextAttemptAt: string | null,
  ): Promise<void>;
  markReconnect(connectionId: string, userId: string): Promise<void>;
}

export interface PushGoogleAdapter {
  insert(
    connection: PushConnection,
    calendar: PushCalendar,
    googleCalendarId: string,
    googleEventId: string,
    payload: Record<string, unknown>,
  ): Promise<GooglePushEvent>;
  update(
    connection: PushConnection,
    calendar: PushCalendar,
    googleCalendarId: string,
    googleEventId: string,
    payload: Record<string, unknown>,
    options: { ifMatch: string },
  ): Promise<GooglePushEvent>;
  get(
    connection: PushConnection,
    calendar: PushCalendar,
    googleCalendarId: string,
    googleEventId: string,
  ): Promise<GooglePushEvent>;
  delete(
    connection: PushConnection,
    calendar: PushCalendar,
    googleCalendarId: string,
    googleEventId: string,
  ): Promise<GoogleDeleteResponse>;
}

function googleEventUrl(googleCalendarId: string, googleEventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleCalendarId)}/events`;
  return googleEventId ? `${base}/${encodeURIComponent(googleEventId)}` : base;
}

async function readGoogleEvent(response: Response): Promise<GooglePushEvent> {
  try {
    return await response.json() as GooglePushEvent;
  } catch {
    throw new GooglePushError("validation", 502);
  }
}

/** Uses the Task 5 authenticated client; dependencies stay injectable for tests and orchestration. */
export function createGooglePushAdapter(
  clientDependencies: GoogleClientDependencies = {},
): PushGoogleAdapter {
  const request = (connection: PushConnection, input: Request) => (
    googleFetch(connection as unknown as GoogleConnection, input, clientDependencies)
  );
  return {
    async insert(connection, _calendar, googleCalendarId, googleEventId, payload) {
      const response = await request(connection, new Request(googleEventUrl(googleCalendarId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, id: googleEventId }),
      }));
      return await readGoogleEvent(response);
    },
    async update(connection, _calendar, googleCalendarId, googleEventId, payload, options) {
      const response = await request(connection, new Request(googleEventUrl(googleCalendarId, googleEventId), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "If-Match": options.ifMatch,
        },
        body: JSON.stringify(payload),
      }));
      return await readGoogleEvent(response);
    },
    async get(connection, _calendar, googleCalendarId, googleEventId) {
      return await readGoogleEvent(await request(
        connection,
        new Request(googleEventUrl(googleCalendarId, googleEventId)),
      ));
    },
    async delete(connection, _calendar, googleCalendarId, googleEventId) {
      const response = await request(connection, new Request(googleEventUrl(googleCalendarId, googleEventId), {
        method: "DELETE",
      }));
      if (response.status === 204) return { status: 204 };
      return { status: response.status, event: await readGoogleEvent(response) };
    },
  };
}

export interface PushDependencies {
  store: PushStore;
  google: PushGoogleAdapter;
  now?: () => string;
  jitter?: (baseDelay: number, attempt: number) => number;
}

export interface PushResult {
  status: "complete" | "retry" | "failed";
  finalizeLocalDelete: boolean;
  errorCategory?: PushErrorCategory;
  conflictWinner?: "family" | "google" | "unchanged";
}

export class GooglePushError extends Error {
  readonly category: PushErrorCategory;
  readonly status: number;

  constructor(category: PushErrorCategory, status: number, message = "Google Calendar operation failed") {
    super(message);
    this.name = "GooglePushError";
    this.category = category;
    this.status = status;
  }
}

const SAFE_MESSAGES: Record<PushErrorCategory, string> = {
  authorization: "Google authorization needs reconnecting",
  permission: "Google calendar is not writable",
  validation: "The calendar event could not be synchronized",
  rate_limit: "Google Calendar is temporarily busy",
  transient: "Google Calendar is temporarily unavailable",
  permanent: "The calendar event could not be synchronized",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stableGoogleEventId(familyEventId: string): string {
  if (!UUID_PATTERN.test(familyEventId)) {
    throw new GooglePushError("validation", 400);
  }
  return `fh${familyEventId.replaceAll("-", "").toLowerCase()}`;
}

function errorCategory(error: unknown): PushErrorCategory {
  const category = (error as { category?: unknown })?.category;
  if (["authorization", "permission", "validation", "rate_limit", "transient", "permanent"].includes(category as string)) {
    return category as PushErrorCategory;
  }
  const status = Number((error as { status?: unknown })?.status);
  if (status === 401) return "authorization";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  if (status >= 400) return "validation";
  if (error instanceof TypeError) return "validation";
  return "transient";
}

function statusOf(error: unknown): number {
  return Number((error as { status?: unknown })?.status) || 0;
}

function assertScopedWritableContext(job: ClaimedPushJob, context: PushContext): void {
  const { familyEvent, mapping, connection, calendar } = context;
  if (
    !job.id ||
    !job.claim_token ||
    !["create", "update", "delete"].includes(job.operation) ||
    familyEvent.id !== job.family_event_id ||
    mapping.id !== job.google_event_mapping_id ||
    mapping.family_event_id !== familyEvent.id ||
    mapping.google_connection_id !== connection.id ||
    mapping.google_calendar_id !== calendar.id ||
    calendar.google_connection_id !== connection.id ||
    familyEvent.household_id !== connection.household_id ||
    !context.ownerUserId ||
    connection.user_id !== context.ownerUserId ||
    connection.connection_state !== "active" ||
    !calendar.enabled ||
    !calendar.is_writable ||
    !calendar.google_calendar_id
  ) {
    throw new GooglePushError("permission", 403);
  }
}

function assertConfirmedEvent(event: GooglePushEvent, expectedId: string): GooglePushEvent {
  if (
    !event ||
    event.id !== expectedId ||
    typeof event.etag !== "string" ||
    !event.etag ||
    typeof event.updated !== "string" ||
    Number.isNaN(Date.parse(event.updated))
  ) {
    throw new GooglePushError("validation", 502);
  }
  return event;
}

interface RemoteWriteOutcome {
  event?: GooglePushEvent;
  conflictWinner?: PushResult["conflictWinner"];
  finalizeLocalDelete: boolean;
  reconcileGoogleEvent?: GooglePushEvent;
  reconcileFamilyEvent?: Record<string, unknown>;
}

function translatedGoogleEvent(
  context: PushContext,
  event: GooglePushEvent,
): Record<string, unknown> {
  const translated = googleToFamilyEvent(event, {
    householdId: context.familyEvent.household_id,
    defaultPersonId: context.familyEvent.person_id,
    householdTimeZone: context.householdTimeZone,
  });
  if (!translated.supported) throw new GooglePushError("validation", 409);
  return translated.event as Record<string, unknown>;
}

async function updateAfterConflict(
  context: PushContext,
  dependencies: PushDependencies,
  eventId: string,
  payload: Record<string, unknown>,
  etag: string,
): Promise<GooglePushEvent> {
  try {
    return assertConfirmedEvent(await dependencies.google.update(
      context.connection,
      context.calendar,
      context.calendar.google_calendar_id,
      eventId,
      payload,
      { ifMatch: etag },
    ), eventId);
  } catch (error) {
    if (statusOf(error) === 412) throw new GooglePushError("transient", 409);
    throw error;
  }
}

async function resolveFetchedEvent(
  context: PushContext,
  dependencies: PushDependencies,
  eventId: string,
  payload: Record<string, unknown>,
  fetched: GooglePushEvent,
): Promise<RemoteWriteOutcome> {
  if (fetched?.id !== eventId) {
    throw new GooglePushError("transient", 409);
  }
  if (fetched.status === "cancelled") {
    let conflictWinner: PushResult["conflictWinner"];
    if (typeof fetched.updated === "string" && !Number.isNaN(Date.parse(fetched.updated))) {
      conflictWinner = chooseConflictWinner(context.mapping, context.familyEvent, fetched);
    } else {
      const localState = chooseConflictWinner(context.mapping, context.familyEvent, {
        updated: context.mapping.last_google_updated_at,
      });
      if (localState !== "unchanged") throw new GooglePushError("transient", 409);
      conflictWinner = "google";
    }
    if (conflictWinner === "family") throw new GooglePushError("transient", 409);
    return { conflictWinner, finalizeLocalDelete: true };
  }

  const confirmed = assertConfirmedEvent(fetched, eventId);
  const conflictWinner = chooseConflictWinner(context.mapping, context.familyEvent, confirmed);
  const reconcileFamilyEvent = translatedGoogleEvent(context, confirmed);
  if (conflictWinner === "family") {
    const event = await updateAfterConflict(context, dependencies, eventId, payload, confirmed.etag);
    return { event, conflictWinner, finalizeLocalDelete: false };
  }
  return {
    event: confirmed,
    conflictWinner,
    finalizeLocalDelete: false,
    reconcileGoogleEvent: confirmed,
    reconcileFamilyEvent,
  };
}

function mappingConfirmation(
  familyEvent: FamilyPushEvent,
  googleEvent: GooglePushEvent,
): NonNullable<PushCompletion["mapping"]> {
  return {
    google_event_id: googleEvent.id,
    google_etag: googleEvent.etag,
    google_updated_at: googleEvent.updated,
    last_family_updated_at: familyEvent.updated_at,
    last_google_updated_at: googleEvent.updated,
    sync_state: "synced",
    safe_error_message: null,
  };
}

function completionForOutcome(
  familyEvent: FamilyPushEvent,
  outcome: RemoteWriteOutcome,
): PushCompletion {
  if (outcome.finalizeLocalDelete) return { finalizeLocalDelete: true };
  if (!outcome.event) throw new GooglePushError("transient", 503);

  const confirmedMapping = mappingConfirmation(familyEvent, outcome.event);
  const { last_family_updated_at: _staleFamilyTimestamp, ...reconciledMapping } = confirmedMapping;
  return {
    finalizeLocalDelete: false,
    mapping: outcome.reconcileGoogleEvent ? reconciledMapping : confirmedMapping,
    ...(outcome.reconcileGoogleEvent
      ? {
        reconcileGoogleEvent: outcome.reconcileGoogleEvent,
        reconcileFamilyEvent: outcome.reconcileFamilyEvent,
        captureReconciledFamilyUpdatedAt: true as const,
      }
      : {}),
  };
}

function googleIdFor(job: ClaimedPushJob, mapping: PushMapping): string {
  if (job.operation === "create") return stableGoogleEventId(job.family_event_id);
  return mapping.google_event_id || stableGoogleEventId(job.family_event_id);
}

async function createRemoteEvent(
  job: ClaimedPushJob,
  context: PushContext,
  dependencies: PushDependencies,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<RemoteWriteOutcome> {
  try {
    const event = assertConfirmedEvent(await dependencies.google.insert(
      context.connection,
      context.calendar,
      context.calendar.google_calendar_id,
      eventId,
      payload,
    ), eventId);
    return { event, finalizeLocalDelete: false };
  } catch (error) {
    if (statusOf(error) !== 409) throw error;
    const fetched = await dependencies.google.get(
      context.connection,
      context.calendar,
      context.calendar.google_calendar_id,
      eventId,
    );
    return await resolveFetchedEvent(context, dependencies, eventId, payload, fetched);
  }
}

async function updateRemoteEvent(
  context: PushContext,
  dependencies: PushDependencies,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<RemoteWriteOutcome> {
  if (!context.mapping.google_etag) throw new GooglePushError("validation", 409);
  try {
    const event = await dependencies.google.update(
      context.connection,
      context.calendar,
      context.calendar.google_calendar_id,
      eventId,
      payload,
      { ifMatch: context.mapping.google_etag },
    );
    return { event: assertConfirmedEvent(event, eventId), finalizeLocalDelete: false };
  } catch (error) {
    if (statusOf(error) !== 412) throw error;
    const current = await dependencies.google.get(
      context.connection,
      context.calendar,
      context.calendar.google_calendar_id,
      eventId,
    );
    return await resolveFetchedEvent(context, dependencies, eventId, payload, current);
  }
}

async function deleteRemoteEvent(
  context: PushContext,
  dependencies: PushDependencies,
  eventId: string,
): Promise<void> {
  try {
    const response = await dependencies.google.delete(
      context.connection,
      context.calendar,
      context.calendar.google_calendar_id,
      eventId,
    );
    if (response.status === 204 || response.status === 404 || response.event?.status === "cancelled") return;
    throw new GooglePushError("validation", response.status || 502);
  } catch (error) {
    if (statusOf(error) === 404) return;
    throw error;
  }
}

async function recordFailure(
  job: ClaimedPushJob,
  dependencies: PushDependencies,
  context: PushContext | null,
  error: unknown,
): Promise<PushResult> {
  const category = errorCategory(error);
  if (category === "authorization" && context) {
    await dependencies.store.markReconnect(context.connection.id, context.connection.user_id);
  }
  const now = dependencies.now?.() ?? new Date().toISOString();
  const decision = retryDecision(category, job.attempt_count, now, { jitter: dependencies.jitter });
  await dependencies.store.fail(
    job.id,
    job.claim_token,
    category,
    SAFE_MESSAGES[category],
    decision.nextAttemptAt,
  );
  return {
    status: decision.retryable ? "retry" : "failed",
    finalizeLocalDelete: false,
    errorCategory: category,
  };
}

export async function processPushJob(
  job: ClaimedPushJob,
  dependencies: PushDependencies,
): Promise<PushResult> {
  let context: PushContext | null = null;
  let completion: PushCompletion;
  let conflictWinner: PushResult["conflictWinner"];

  try {
    context = await dependencies.store.loadContext(job);
    assertScopedWritableContext(job, context);
    const eventId = googleIdFor(job, context.mapping);

    if (job.operation === "delete") {
      await deleteRemoteEvent(context, dependencies, eventId);
      completion = { finalizeLocalDelete: true };
    } else {
      const payload = familyToGoogleEvent(context.familyEvent, {
        householdId: context.familyEvent.household_id,
        householdTimeZone: context.householdTimeZone,
      }) as Record<string, unknown>;
      if (job.operation === "create") {
        const created = await createRemoteEvent(job, context, dependencies, eventId, payload);
        conflictWinner = created.conflictWinner;
        completion = completionForOutcome(context.familyEvent, created);
      } else {
        const updated = await updateRemoteEvent(context, dependencies, eventId, payload);
        conflictWinner = updated.conflictWinner;
        completion = completionForOutcome(context.familyEvent, updated);
      }
    }
  } catch (error) {
    return await recordFailure(job, dependencies, context, error);
  }

  await dependencies.store.complete(job.id, job.claim_token, completion);
  return {
    status: "complete",
    finalizeLocalDelete: completion.finalizeLocalDelete,
    ...(conflictWinner ? { conflictWinner } : {}),
  };
}
