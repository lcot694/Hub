import { googleToFamilyEvent } from "../../../lib/google-event-model.js";
import { chooseConflictWinner } from "../../../lib/sync-policy.js";
import {
  googleFetch,
  type GoogleClientDependencies,
  type GoogleConnection,
  type GoogleErrorCategory,
} from "./google-client.ts";

export interface PullConnection extends GoogleConnection {
  household_id: string;
  person_id: string;
  connection_state: "active" | "reconnect_required" | "disconnected";
}

export interface PullCalendar {
  id: string;
  google_connection_id: string;
  google_calendar_id: string;
  enabled: boolean;
  is_writable: boolean;
  sync_token: string | null;
  time_zone: string | null;
  ownerUserId: string;
  householdTimeZone: string;
  connection: PullConnection;
}

export interface GooglePullEvent {
  id: string;
  status?: string;
  etag?: string;
  updated?: string;
  recurringEventId?: string;
  originalStartTime?: unknown;
  [key: string]: unknown;
}

export interface GoogleEventsPage {
  items?: GooglePullEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface PullPageRequest {
  singleEvents: false;
  showDeleted: true;
  syncToken?: string;
  pageToken?: string;
}

export interface PullMapping {
  id: string;
  family_event_id: string;
  google_connection_id: string;
  google_calendar_id: string;
  google_event_id: string;
  google_etag: string | null;
  google_updated_at: string | null;
  last_family_updated_at: string | null;
  last_google_updated_at: string | null;
  sync_state: "synced" | "syncing" | "needs_attention" | "read_only";
}

export interface PullFamilyEvent {
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
  [key: string]: unknown;
}

export interface MappedPullEvent {
  mapping: PullMapping;
  familyEvent: PullFamilyEvent;
}

interface MappingObservation {
  google_etag: string | null;
  google_updated_at: string | null;
  last_google_updated_at?: string;
  last_family_updated_at?: string;
  sync_state: PullMapping["sync_state"];
  safe_error_message: string | null;
}

export interface ImportPullChange {
  kind: "import";
  googleEventId: string;
  familyEvent: Record<string, unknown>;
  mapping: MappingObservation;
  captureFamilyUpdatedAt: true;
}

export interface UpdatePullChange {
  kind: "update";
  googleEventId: string;
  familyEventId: string;
  familyEventPatch: Record<string, unknown>;
  mapping: MappingObservation;
  captureFamilyUpdatedAt: true;
  conflictWinner: "google" | "unchanged";
}

export interface KeepFamilyPullChange {
  kind: "keep_family";
  googleEventId: string;
  familyEventId: string;
  mapping: MappingObservation;
  conflictWinner: "family";
}

export interface CancelPullChange {
  kind: "cancel";
  googleEventId: string;
  familyEventId: string;
  googleUpdatedAt: string | null;
  conflictWinner: "google" | "unchanged";
}

export interface CancellationConflictPullChange {
  kind: "cancellation_conflict";
  googleEventId: string;
  familyEventId: string;
  mapping: MappingObservation;
  conflictWinner: "family";
}

export interface ReadOnlyPullChange {
  kind: "read_only";
  googleEventId: string;
  familyEventId: string;
  mapping: MappingObservation;
  conflictWinner: "google" | "unchanged";
}

export interface IgnorePullChange {
  kind: "ignore";
  googleEventId: string;
}

export type PullChange =
  | ImportPullChange
  | UpdatePullChange
  | KeepFamilyPullChange
  | CancelPullChange
  | CancellationConflictPullChange
  | ReadOnlyPullChange
  | IgnorePullChange;

export interface PullPageReconciliation {
  scanId: string | null;
  seenGoogleEventIds: string[];
}

export interface PullStore {
  loadMappedEvent(calendar: PullCalendar, googleEventId: string): Promise<MappedPullEvent | null>;
  /** Apply the complete bounded page atomically; imports must upsert on the scoped Google event key. */
  applyPage(
    calendar: PullCalendar,
    changes: PullChange[],
    reconciliation: PullPageReconciliation,
  ): Promise<void>;
  saveSyncToken(calendar: PullCalendar, nextSyncToken: string): Promise<void>;
  clearSyncToken(calendar: PullCalendar): Promise<void>;
  beginFullReconciliation(calendar: PullCalendar): Promise<string>;
  /** Atomically delete unseen mapped events and commit the new token only after the complete scan. */
  finishFullReconciliation(calendar: PullCalendar, scanId: string, nextSyncToken: string): Promise<void>;
  markReconnect(connectionId: string, ownerUserId: string): Promise<void>;
  recordFailure(calendar: PullCalendar, category: PullErrorCategory, safeMessage: string): Promise<void>;
}

export interface PullGoogleAdapter {
  list(
    connection: PullConnection,
    calendar: PullCalendar,
    googleCalendarId: string,
    request: PullPageRequest,
  ): Promise<GoogleEventsPage>;
}

export interface PullDependencies {
  store: PullStore;
  google: PullGoogleAdapter;
}

export interface PullResult {
  status: "complete";
  mode: "incremental" | "full";
  pages: number;
  processed: number;
  nextSyncToken: string;
}

export type PullErrorCategory = GoogleErrorCategory;

const SAFE_MESSAGES: Record<PullErrorCategory, string> = {
  authorization: "Google authorization needs reconnecting",
  permission: "Google calendar is not available for synchronization",
  validation: "The calendar events could not be synchronized",
  rate_limit: "Google Calendar is temporarily busy",
  transient: "Google Calendar is temporarily unavailable",
  permanent: "The calendar events could not be synchronized",
};

const READ_ONLY_MESSAGES: Record<string, string> = {
  complex_recurrence: "Google event has an unsupported recurrence pattern",
  complex_recurrence_exception: "Google event has an unsupported recurrence exception",
  recurring_time_zone_mismatch: "Google recurring event uses a different time zone",
  multi_day_event: "Google multi-day event is read-only",
  ambiguous_local_time: "Google event has an ambiguous local time",
  unsupported_event_time: "Google event has unsupported timing",
};

export class GooglePullError extends Error {
  readonly category: PullErrorCategory;
  readonly status: number;

  constructor(category: PullErrorCategory, status: number, message = SAFE_MESSAGES[category]) {
    super(message);
    this.name = "GooglePullError";
    this.category = category;
    this.status = status;
  }
}

function statusOf(error: unknown): number {
  return Number((error as { status?: unknown })?.status) || 0;
}

function categoryOf(error: unknown): PullErrorCategory {
  const category = (error as { category?: unknown })?.category;
  if (["authorization", "permission", "validation", "rate_limit", "transient", "permanent"].includes(category as string)) {
    return category as PullErrorCategory;
  }
  const status = statusOf(error);
  if (status === 401) return "authorization";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  if (status >= 400) return "validation";
  if (error instanceof TypeError) return "validation";
  return "transient";
}

function assertCalendarScope(calendar: PullCalendar): void {
  const { connection } = calendar;
  if (
    !calendar.id ||
    !calendar.google_calendar_id ||
    !calendar.enabled ||
    !calendar.ownerUserId ||
    !connection?.id ||
    connection.id !== calendar.google_connection_id ||
    connection.user_id !== calendar.ownerUserId ||
    connection.connection_state !== "active" ||
    !connection.household_id ||
    !connection.person_id ||
    !calendar.householdTimeZone
  ) {
    throw new GooglePullError("permission", 403);
  }
}

function assertMappedScope(calendar: PullCalendar, mapped: MappedPullEvent, googleEventId: string): void {
  if (
    mapped.mapping.google_connection_id !== calendar.connection.id ||
    mapped.mapping.google_calendar_id !== calendar.id ||
    mapped.mapping.google_event_id !== googleEventId ||
    mapped.mapping.family_event_id !== mapped.familyEvent.id ||
    mapped.familyEvent.household_id !== calendar.connection.household_id
  ) {
    throw new GooglePullError("permission", 403);
  }
}

function requiredGoogleObservation(event: GooglePullEvent): { etag: string; updated: string } {
  if (
    typeof event.etag !== "string" ||
    !event.etag ||
    typeof event.updated !== "string" ||
    Number.isNaN(Date.parse(event.updated))
  ) {
    throw new GooglePullError("validation", 502);
  }
  return { etag: event.etag, updated: event.updated };
}

function mappingObservation(
  event: GooglePullEvent,
  syncState: PullMapping["sync_state"],
  safeErrorMessage: string | null = null,
): MappingObservation {
  const { etag, updated } = requiredGoogleObservation(event);
  return {
    google_etag: etag,
    google_updated_at: updated,
    last_google_updated_at: updated,
    sync_state: syncState,
    safe_error_message: safeErrorMessage,
  };
}

function synchronizedObservation(calendar: PullCalendar, event: GooglePullEvent): MappingObservation {
  return mappingObservation(
    event,
    calendar.is_writable ? "synced" : "read_only",
    calendar.is_writable ? null : "Google calendar is read-only",
  );
}

function familyEventPatch(translated: Record<string, unknown>): Record<string, unknown> {
  const {
    household_id: _householdId,
    person_id: _personId,
    ...googleOwnedFields
  } = translated;
  return googleOwnedFields;
}

function cancellationWinner(mapped: MappedPullEvent, event: GooglePullEvent): "family" | "google" | "unchanged" {
  if (typeof event.updated === "string" && !Number.isNaN(Date.parse(event.updated))) {
    return chooseConflictWinner(mapped.mapping, mapped.familyEvent, event);
  }
  const localState = chooseConflictWinner(mapped.mapping, mapped.familyEvent, {
    updated: mapped.mapping.last_google_updated_at,
  });
  return localState === "unchanged" ? "google" : "family";
}

function keepFamilyChange(
  calendar: PullCalendar,
  mapped: MappedPullEvent,
  event: GooglePullEvent,
): KeepFamilyPullChange {
  const observation = mappingObservation(
    event,
    calendar.is_writable ? "syncing" : "needs_attention",
    calendar.is_writable ? null : "Google calendar is read-only",
  );
  delete observation.last_google_updated_at;
  return {
    kind: "keep_family",
    googleEventId: event.id,
    familyEventId: mapped.familyEvent.id,
    mapping: observation,
    conflictWinner: "family",
  };
}

async function changeForEvent(
  calendar: PullCalendar,
  dependencies: PullDependencies,
  event: GooglePullEvent,
): Promise<PullChange> {
  if (!event || typeof event.id !== "string" || !event.id) {
    throw new GooglePullError("validation", 502);
  }
  const mapped = await dependencies.store.loadMappedEvent(calendar, event.id);
  if (mapped) assertMappedScope(calendar, mapped, event.id);

  if (event.status === "cancelled") {
    if (!mapped) return { kind: "ignore", googleEventId: event.id };
    const conflictWinner = cancellationWinner(mapped, event);
    if (conflictWinner === "family") return {
      kind: "cancellation_conflict",
      googleEventId: event.id,
      familyEventId: mapped.familyEvent.id,
      mapping: {
        google_etag: typeof event.etag === "string" ? event.etag : mapped.mapping.google_etag,
        google_updated_at: typeof event.updated === "string" && !Number.isNaN(Date.parse(event.updated))
          ? event.updated
          : mapped.mapping.google_updated_at,
        sync_state: "needs_attention",
        safe_error_message: "Google deleted this event while Family Hub had newer changes",
      },
      conflictWinner: "family",
    };
    return {
      kind: "cancel",
      googleEventId: event.id,
      familyEventId: mapped.familyEvent.id,
      googleUpdatedAt: typeof event.updated === "string" && !Number.isNaN(Date.parse(event.updated))
        ? event.updated
        : null,
      conflictWinner,
    };
  }

  const observation = requiredGoogleObservation(event);
  const conflictWinner = mapped
    ? chooseConflictWinner(mapped.mapping, mapped.familyEvent, event)
    : null;
  if (mapped && conflictWinner === "family") return keepFamilyChange(calendar, mapped, event);

  const translated = googleToFamilyEvent(event, {
    householdId: calendar.connection.household_id,
    defaultPersonId: calendar.connection.person_id,
    householdTimeZone: calendar.householdTimeZone,
  });
  if (!translated.supported) {
    if (!mapped) return { kind: "ignore", googleEventId: event.id };
    const safeMessage = READ_ONLY_MESSAGES[translated.readOnlyReason] || "Google event has unsupported content";
    return {
      kind: "read_only",
      googleEventId: event.id,
      familyEventId: mapped.familyEvent.id,
      mapping: mappingObservation(event, "read_only", safeMessage),
      conflictWinner: conflictWinner as "google" | "unchanged",
    };
  }

  if (!mapped) {
    return {
      kind: "import",
      googleEventId: event.id,
      familyEvent: translated.event as Record<string, unknown>,
      mapping: {
        google_etag: observation.etag,
        google_updated_at: observation.updated,
        last_google_updated_at: observation.updated,
        sync_state: calendar.is_writable ? "synced" : "read_only",
        safe_error_message: calendar.is_writable ? null : "Google calendar is read-only",
      },
      captureFamilyUpdatedAt: true,
    };
  }

  return {
    kind: "update",
    googleEventId: event.id,
    familyEventId: mapped.familyEvent.id,
    familyEventPatch: familyEventPatch(translated.event as Record<string, unknown>),
    mapping: synchronizedObservation(calendar, event),
    captureFamilyUpdatedAt: true,
    conflictWinner: conflictWinner as "google" | "unchanged",
  };
}

function validatedPage(page: GoogleEventsPage): { items: GooglePullEvent[]; nextPageToken?: string; nextSyncToken?: string } {
  if (!page || (page.items !== undefined && !Array.isArray(page.items))) {
    throw new GooglePullError("validation", 502);
  }
  for (const token of [page.nextPageToken, page.nextSyncToken]) {
    if (token !== undefined && (typeof token !== "string" || !token)) {
      throw new GooglePullError("validation", 502);
    }
  }
  if (page.nextPageToken && page.nextSyncToken) throw new GooglePullError("validation", 502);
  return { items: page.items || [], nextPageToken: page.nextPageToken, nextSyncToken: page.nextSyncToken };
}

async function runPull(
  calendar: PullCalendar,
  dependencies: PullDependencies,
  mode: "incremental" | "full",
): Promise<PullResult> {
  const scanId = mode === "full" ? await dependencies.store.beginFullReconciliation(calendar) : null;
  const visitedPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  let processed = 0;

  while (true) {
    const request: PullPageRequest = {
      singleEvents: false,
      showDeleted: true,
      ...(mode === "incremental" ? { syncToken: calendar.sync_token as string } : {}),
      ...(pageToken ? { pageToken } : {}),
    };
    const page = validatedPage(await dependencies.google.list(
      calendar.connection,
      calendar,
      calendar.google_calendar_id,
      request,
    ));
    const changes: PullChange[] = [];
    for (const event of page.items) changes.push(await changeForEvent(calendar, dependencies, event));
    await dependencies.store.applyPage(calendar, changes, {
      scanId,
      seenGoogleEventIds: page.items.map(({ id }) => id),
    });
    pages += 1;
    processed += page.items.length;

    if (page.nextPageToken) {
      if (visitedPageTokens.has(page.nextPageToken)) throw new GooglePullError("validation", 502);
      visitedPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
      continue;
    }
    if (!page.nextSyncToken) throw new GooglePullError("validation", 502);
    if (mode === "full") {
      await dependencies.store.finishFullReconciliation(calendar, scanId as string, page.nextSyncToken);
    } else {
      await dependencies.store.saveSyncToken(calendar, page.nextSyncToken);
    }
    return {
      status: "complete",
      mode,
      pages,
      processed,
      nextSyncToken: page.nextSyncToken,
    };
  }
}

async function recordSanitizedFailure(
  calendar: PullCalendar,
  dependencies: PullDependencies,
  category: PullErrorCategory,
): Promise<void> {
  try {
    if (category === "authorization") {
      await dependencies.store.markReconnect(calendar.connection.id, calendar.ownerUserId);
    }
    await dependencies.store.recordFailure(calendar, category, SAFE_MESSAGES[category]);
  } catch {
    // The outward error remains fixed and sanitized even if failure bookkeeping fails.
  }
}

export async function pullCalendar(
  calendar: PullCalendar,
  dependencies: PullDependencies,
): Promise<PullResult> {
  assertCalendarScope(calendar);
  try {
    if (!calendar.sync_token) return await runPull(calendar, dependencies, "full");
    try {
      return await runPull(calendar, dependencies, "incremental");
    } catch (error) {
      if (statusOf(error) !== 410) throw error;
      await dependencies.store.clearSyncToken(calendar);
      return await runPull({ ...calendar, sync_token: null }, dependencies, "full");
    }
  } catch (error) {
    const category = categoryOf(error);
    await recordSanitizedFailure(calendar, dependencies, category);
    throw new GooglePullError(category, statusOf(error) || 503);
  }
}

function eventsUrl(googleCalendarId: string, request: PullPageRequest): string {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleCalendarId)}/events`);
  url.searchParams.set("singleEvents", String(request.singleEvents));
  url.searchParams.set("showDeleted", String(request.showDeleted));
  if (request.syncToken) url.searchParams.set("syncToken", request.syncToken);
  if (request.pageToken) url.searchParams.set("pageToken", request.pageToken);
  return url.toString();
}

/** Production Google Calendar events.list adapter over the authenticated Task 5 client. */
export function createGooglePullAdapter(
  clientDependencies: GoogleClientDependencies = {},
): PullGoogleAdapter {
  return {
    async list(connection, _calendar, googleCalendarId, request) {
      const response = await googleFetch(
        connection,
        new Request(eventsUrl(googleCalendarId, request)),
        clientDependencies,
      );
      try {
        return await response.json() as GoogleEventsPage;
      } catch {
        throw new GooglePullError("validation", 502);
      }
    },
  };
}
