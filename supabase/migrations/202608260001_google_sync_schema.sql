-- Google Calendar synchronization is additive: historical setup scripts remain unchanged.

alter table public.households
  add column if not exists time_zone text not null default 'America/Toronto';

alter table public.events
  add column if not exists all_day boolean not null default false,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists sync_deleted_at timestamptz;

alter table public.events
  drop constraint if exists events_recurrence_check,
  add constraint events_recurrence_check
    check (recurrence in ('none','daily','weekly','monthly','yearly'));

create or replace function public.events_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists events_set_updated_at on public.events;
create trigger events_set_updated_at
before update on public.events
for each row execute function public.events_set_updated_at();

create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete restrict,
  google_account_id text not null,
  display_email text,
  access_token_encrypted bytea,
  refresh_token_encrypted bytea,
  token_expires_at timestamptz,
  connection_state text not null default 'active'
    check (connection_state in ('active','reconnect_required','disconnected')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (user_id)
);

create table public.google_calendars (
  id uuid primary key default gen_random_uuid(),
  google_connection_id uuid not null references public.google_connections(id) on delete cascade,
  google_calendar_id text not null,
  display_name text not null,
  time_zone text,
  enabled boolean not null default false,
  google_access_role text not null
    check (google_access_role in ('freeBusyReader','reader','writer','owner')),
  is_writable boolean generated always as (google_access_role in ('writer','owner')) stored,
  sync_token text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, google_connection_id),
  unique (google_connection_id, google_calendar_id)
);

create table public.google_event_mappings (
  id uuid primary key default gen_random_uuid(),
  family_event_id uuid not null references public.events(id) on delete restrict,
  google_connection_id uuid not null references public.google_connections(id) on delete cascade,
  google_calendar_id uuid not null references public.google_calendars(id) on delete cascade,
  google_event_id text not null,
  google_recurring_event_id text,
  google_updated_at timestamptz,
  google_etag text,
  last_family_updated_at timestamptz,
  last_google_updated_at timestamptz,
  sync_state text not null default 'syncing'
    check (sync_state in ('synced','syncing','needs_attention','read_only')),
  safe_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_event_id),
  unique (id, family_event_id),
  foreign key (google_calendar_id, google_connection_id)
    references public.google_calendars(id, google_connection_id) on delete cascade,
  unique (google_connection_id, google_calendar_id, google_event_id)
);

create table public.google_sync_queue (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null default gen_random_uuid() unique,
  family_event_id uuid not null references public.events(id) on delete restrict,
  google_event_mapping_id uuid not null references public.google_event_mappings(id) on delete cascade,
  operation text not null check (operation in ('create','update','delete')),
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','superseded')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claim_token uuid,
  error_category text,
  safe_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (google_event_mapping_id, family_event_id)
    references public.google_event_mappings(id, family_event_id) on delete cascade
);

create table public.google_oauth_flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  state_hash text not null unique,
  redirect_path text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index google_connections_user_id_idx on public.google_connections(user_id);
create index google_calendars_connection_id_idx on public.google_calendars(google_connection_id);
create index google_event_mappings_family_event_id_idx on public.google_event_mappings(family_event_id);
create index google_sync_queue_due_jobs_idx on public.google_sync_queue(next_attempt_at, created_at)
  where status = 'pending';
create unique index google_sync_queue_one_pending_event_idx
  on public.google_sync_queue(family_event_id)
  where status = 'pending';
create unique index google_sync_queue_one_processing_event_idx
  on public.google_sync_queue(family_event_id)
  where status = 'processing';

create or replace function public.enforce_google_connection_person()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.people
    where id = new.person_id
      and household_id = new.household_id
  ) then
    raise exception 'Google connection person must belong to its household';
  end if;
  return new;
end;
$$;

create trigger google_connections_person_in_household
before insert or update of household_id, person_id on public.google_connections
for each row execute function public.enforce_google_connection_person();

create or replace function public.enforce_google_event_mapping_scope()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.events e
    join public.google_connections c on c.id = new.google_connection_id
    where e.id = new.family_event_id
      and e.household_id = c.household_id
  ) then
    raise exception 'Google event mapping must stay within one household';
  end if;
  return new;
end;
$$;

create trigger google_event_mappings_same_household
before insert or update of family_event_id, google_connection_id on public.google_event_mappings
for each row execute function public.enforce_google_event_mapping_scope();

alter table public.google_connections enable row level security;
alter table public.google_calendars enable row level security;
alter table public.google_event_mappings enable row level security;
alter table public.google_sync_queue enable row level security;
alter table public.google_oauth_flows enable row level security;

-- Browser roles never read connection credentials, OAuth state, mappings, or queue rows.
revoke all on table public.google_connections, public.google_calendars,
  public.google_event_mappings, public.google_sync_queue, public.google_oauth_flows
  from anon, authenticated;
grant all on table public.google_connections, public.google_calendars,
  public.google_event_mappings, public.google_sync_queue, public.google_oauth_flows
  to service_role;

create or replace function public.get_google_sync_status()
returns table (
  google_connection_id uuid,
  household_id uuid,
  person_id uuid,
  display_email text,
  connection_state text,
  connection_error text,
  google_calendar_id uuid,
  calendar_name text,
  calendar_time_zone text,
  calendar_enabled boolean,
  calendar_writable boolean,
  family_event_id uuid,
  sync_state text,
  sync_error text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.household_id,
    c.person_id,
    c.display_email,
    c.connection_state,
    c.last_error,
    cal.id,
    cal.display_name,
    cal.time_zone,
    cal.enabled,
    cal.is_writable,
    m.family_event_id,
    m.sync_state,
    m.safe_error_message
  from public.google_connections c
  left join public.google_calendars cal on cal.google_connection_id = c.id
  left join public.google_event_mappings m on m.google_calendar_id = cal.id
  where c.user_id = auth.uid()
    and public.is_household_member(c.household_id);
$$;

create or replace function public.set_google_calendar_enabled(
  p_google_calendar_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.google_calendars cal
  set enabled = p_enabled,
      updated_at = clock_timestamp()
  from public.google_connections c
  where cal.id = p_google_calendar_id
    and c.id = cal.google_connection_id
    and c.user_id = auth.uid()
    and public.is_household_member(c.household_id);

  if not found then
    raise exception 'Google calendar is not available to this user';
  end if;
end;
$$;

create or replace function public.assert_google_event_change_allowed(
  p_family_event_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return;
  end if;

  if auth.uid() is null or not exists (
    select 1
    from public.events e
    where e.id = p_family_event_id
      and public.is_household_member(e.household_id)
  ) then
    raise exception using
      errcode = '42501',
      message = 'google_event_forbidden';
  end if;

  if exists (
    select 1
    from public.google_event_mappings m
    join public.google_calendars cal on cal.id = m.google_calendar_id
    where m.family_event_id = p_family_event_id
      and not cal.is_writable
  ) then
    raise exception using
      errcode = '42501',
      message = 'google_calendar_read_only';
  end if;

  -- Family-Hub-only events have no mapping and keep their normal direct
  -- update path. Any Google-owned field change must belong to the caller's
  -- active, enabled, writable destination.
  if exists (
    select 1
    from public.google_event_mappings m
    where m.family_event_id = p_family_event_id
  ) and not exists (
    select 1
    from public.google_event_mappings m
    join public.google_connections c on c.id = m.google_connection_id
    join public.google_calendars cal on cal.id = m.google_calendar_id
    where m.family_event_id = p_family_event_id
      and c.user_id = auth.uid()
      and c.connection_state = 'active'
      and cal.enabled and cal.is_writable
  ) then
    raise exception using
      errcode = '42501',
      message = 'google_event_destination_unavailable';
  end if;
end;
$$;

create or replace function public.enqueue_google_event_change_internal(
  p_family_event_id uuid,
  p_operation text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked_event_id uuid;
  v_mapping_id uuid;
  v_mapping_connection_id uuid;
  v_mapping_calendar_id uuid;
  v_locked_connection_id uuid;
  v_processing_id uuid;
  v_processing_operation text;
  v_queue_id uuid;
begin
  if p_operation not in ('create','update','delete') then
    raise exception 'Unsupported Google sync operation';
  end if;

  -- Queue mutations always lock event → mapping → connection/calendar → queue.
  -- Callers use this same order before invoking the helper.
  select e.id into v_locked_event_id
  from public.events e
  where e.id = p_family_event_id
  for update of e;

  if v_locked_event_id is null then
    return null;
  end if;

  select m.id, m.google_connection_id, m.google_calendar_id
  into v_mapping_id, v_mapping_connection_id, v_mapping_calendar_id
  from public.google_event_mappings m
  where m.family_event_id = p_family_event_id
  for update of m;

  if v_mapping_id is null then
    return null;
  end if;

  select c.id into v_locked_connection_id
  from public.google_connections c
  join public.google_calendars cal on cal.google_connection_id = c.id
  where c.id = v_mapping_connection_id
    and cal.id = v_mapping_calendar_id
  for update of c, cal;

  if v_locked_connection_id is null then
    return null;
  end if;

  select q.id, q.operation into v_processing_id, v_processing_operation
  from public.google_sync_queue q
  where q.family_event_id = p_family_event_id
    and q.status = 'processing'
  for update;

  if v_processing_id is not null and v_processing_operation = 'delete' then
    return v_processing_id;
  end if;

  if v_processing_id is not null
    and v_processing_operation = 'create'
    and p_operation = 'create' then
    return v_processing_id;
  end if;

  insert into public.google_sync_queue (
    family_event_id,
    google_event_mapping_id,
    operation
  ) values (
    p_family_event_id,
    v_mapping_id,
    p_operation
  ) on conflict (family_event_id) where status = 'pending'
  do update set
    operation = case
      when public.google_sync_queue.operation = 'delete' then 'delete'
      when excluded.operation = 'delete' then 'delete'
      when public.google_sync_queue.operation = 'create' then 'create'
      else excluded.operation
    end,
    next_attempt_at = clock_timestamp(),
    updated_at = clock_timestamp()
  returning id into v_queue_id;

  return v_queue_id;
end;
$$;

create or replace function public.enqueue_google_event_change(
  p_family_event_id uuid,
  p_operation text
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.enqueue_google_event_change_internal(p_family_event_id, p_operation);
$$;

create or replace function public.events_enqueue_google_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- save_google_backed_event locks and enqueues explicitly so an edit cannot
  -- race its mapping validation with this general-purpose trigger.
  if current_setting('app.skip_google_event_queue', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform public.assert_google_event_change_allowed(new.id);
    perform public.enqueue_google_event_change_internal(new.id, 'create');
  elsif new.title is distinct from old.title
    or new.event_date is distinct from old.event_date
    or new.start_time is distinct from old.start_time
    or new.end_time is distinct from old.end_time
    or new.all_day is distinct from old.all_day
    or new.recurrence is distinct from old.recurrence
    or new.recurrence_end is distinct from old.recurrence_end then
    perform public.assert_google_event_change_allowed(new.id);
    perform public.enqueue_google_event_change_internal(new.id, 'update');
  end if;
  return new;
end;
$$;

drop trigger if exists events_enqueue_google_change on public.events;
create trigger events_enqueue_google_change
after insert or update on public.events
for each row execute function public.events_enqueue_google_change();

create or replace function public.save_google_backed_event(p_event jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
  v_calendar_id uuid;
  v_event_id uuid;
  v_person_id uuid;
  v_connection_id uuid;
  v_title text;
  v_event_date date;
  v_start_time time;
  v_end_time time;
  v_all_day boolean;
  v_recurrence text;
  v_recurrence_end date;
  v_existing_event public.events%rowtype;
  v_mapping public.google_event_mappings%rowtype;
  v_google_changed boolean := false;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'google_event_not_authenticated';
  end if;

  if jsonb_typeof(p_event) <> 'object'
    or not (p_event ? 'household_id')
    or not (p_event ? 'google_calendar_id')
    or not (p_event ? 'title')
    or not (p_event ? 'event_date')
    or not (p_event ? 'all_day')
    or not (p_event ? 'recurrence')
    or jsonb_typeof(p_event->'household_id') <> 'string'
    or jsonb_typeof(p_event->'google_calendar_id') <> 'string'
    or (p_event ? 'id' and jsonb_typeof(p_event->'id') <> 'string')
    or (p_event ? 'person_id' and jsonb_typeof(p_event->'person_id') not in ('string', 'null'))
    or (p_event ? 'title' and jsonb_typeof(p_event->'title') <> 'string')
    or jsonb_typeof(p_event->'event_date') <> 'string'
    or (p_event ? 'start_time' and jsonb_typeof(p_event->'start_time') not in ('string', 'null'))
    or (p_event ? 'end_time' and jsonb_typeof(p_event->'end_time') not in ('string', 'null'))
    or (p_event ? 'all_day' and jsonb_typeof(p_event->'all_day') <> 'boolean')
    or (p_event ? 'recurrence' and jsonb_typeof(p_event->'recurrence') <> 'string')
    or (p_event ? 'recurrence_end' and jsonb_typeof(p_event->'recurrence_end') not in ('string', 'null')) then
    raise exception using
      errcode = '22023',
      message = 'google_event_invalid_payload';
  end if;

  begin
    v_household_id := (p_event->>'household_id')::uuid;
    v_calendar_id := (p_event->>'google_calendar_id')::uuid;
    v_event_id := nullif(p_event->>'id', '')::uuid;
    v_person_id := nullif(p_event->>'person_id', '')::uuid;
    v_event_date := (p_event->>'event_date')::date;
    v_start_time := nullif(p_event->>'start_time', '')::time;
    v_end_time := nullif(p_event->>'end_time', '')::time;
    v_all_day := coalesce((p_event->>'all_day')::boolean, false);
    v_recurrence := coalesce(p_event->>'recurrence', 'none');
    v_recurrence_end := nullif(p_event->>'recurrence_end', '')::date;
  -- UUID/date/time casts can raise 22P02, 22007, or 22008; clients receive
  -- the single safe validation contract instead of parser-specific details.
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception using
      errcode = '22023',
      message = 'google_event_invalid_payload';
  end;

  v_title := btrim(coalesce(p_event->>'title', ''));
  if v_title = ''
    or v_recurrence not in ('none', 'daily', 'weekly', 'monthly', 'yearly') then
    raise exception using
      errcode = '22023',
      message = 'google_event_invalid_payload';
  end if;

  if not public.is_household_member(v_household_id) then
    raise exception using
      errcode = '42501',
      message = 'google_event_forbidden';
  end if;

  if v_person_id is not null and not exists (
    select 1
    from public.people p
    where p.id = v_person_id
      and p.household_id = v_household_id
  ) then
    raise exception using
      errcode = '22023',
      message = 'google_event_invalid_person';
  end if;

  if v_event_id is null then
    -- A new event has no event/mapping rows yet, so it validates and locks
    -- the destination before inserting the transactional event/mapping/job.
    select c.id into v_connection_id
    from public.google_connections c
    join public.google_calendars cal on cal.google_connection_id = c.id
    where cal.id = v_calendar_id
      and c.user_id = auth.uid()
      and c.household_id = v_household_id
      and c.connection_state = 'active'
      and cal.enabled and cal.is_writable
    for update of c, cal;

    if v_connection_id is null then
      raise exception using
        errcode = '42501',
        message = 'google_event_destination_unavailable';
    end if;

    insert into public.events (
      household_id, person_id, title, event_date, start_time, end_time,
      all_day, recurrence, recurrence_end, created_by
    ) values (
      v_household_id, v_person_id, v_title, v_event_date, v_start_time, v_end_time,
      v_all_day, v_recurrence, v_recurrence_end, auth.uid()
    ) returning id into v_event_id;

    insert into public.google_event_mappings (
      family_event_id, google_connection_id, google_calendar_id, google_event_id, sync_state
    ) values (
      v_event_id, v_connection_id, v_calendar_id,
      'fh' || replace(v_event_id::text, '-', ''), 'syncing'
    );

    perform public.enqueue_google_event_change_internal(v_event_id, 'create');
    return v_event_id;
  end if;

  -- Existing mapped-event writes use one lock order: event → mapping →
  -- connection/calendar → queue. This matches delete and prevents inversion.
  select e.* into v_existing_event
  from public.events e
  where e.id = v_event_id
    and e.household_id = v_household_id
  for update of e;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'google_event_not_found';
  end if;

  select m.* into v_mapping
  from public.google_event_mappings m
  where m.family_event_id = v_event_id
  for update of m;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'google_event_destination_unavailable';
  end if;

  select c.id into v_connection_id
  from public.google_connections c
  join public.google_calendars cal on cal.google_connection_id = c.id
  where c.id = v_mapping.google_connection_id
    and cal.id = v_calendar_id
    and v_mapping.google_calendar_id = v_calendar_id
    and c.user_id = auth.uid()
    and c.household_id = v_household_id
    and c.connection_state = 'active'
    and cal.enabled and cal.is_writable
  for update of c, cal;

  if v_connection_id is null then
    raise exception using
      errcode = '42501',
      message = 'google_event_destination_unavailable';
  end if;

  v_google_changed := v_existing_event.title is distinct from v_title
    or v_existing_event.event_date is distinct from v_event_date
    or v_existing_event.start_time is distinct from v_start_time
    or v_existing_event.end_time is distinct from v_end_time
    or v_existing_event.all_day is distinct from v_all_day
    or v_existing_event.recurrence is distinct from v_recurrence
    or v_existing_event.recurrence_end is distinct from v_recurrence_end;

  perform set_config('app.skip_google_event_queue', 'on', true);
  update public.events
  set person_id = v_person_id,
      title = v_title,
      event_date = v_event_date,
      start_time = v_start_time,
      end_time = v_end_time,
      all_day = v_all_day,
      recurrence = v_recurrence,
      recurrence_end = v_recurrence_end
  where id = v_event_id;

  if v_google_changed then
    perform public.enqueue_google_event_change_internal(v_event_id, 'update');
  end if;

  return v_event_id;
end;
$$;

create or replace function public.request_google_event_delete(p_family_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events%rowtype;
  v_mapping public.google_event_mappings%rowtype;
  v_connection_id uuid;
  v_pending_create_id uuid;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'google_event_not_authenticated';
  end if;

  -- Existing mapped-event deletes use event → mapping → connection/calendar
  -- → queue, matching save and the internal queue helper's first two locks.
  select e.* into v_event
  from public.events e
  where e.id = p_family_event_id
    and public.is_household_member(e.household_id)
  for update of e;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'google_event_forbidden';
  end if;

  select m.* into v_mapping
  from public.google_event_mappings m
  where m.family_event_id = p_family_event_id
  for update of m;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'google_event_destination_unavailable';
  end if;

  select c.id into v_connection_id
  from public.google_connections c
  join public.google_calendars cal on cal.google_connection_id = c.id
  where c.id = v_mapping.google_connection_id
    and cal.id = v_mapping.google_calendar_id
    and c.user_id = auth.uid()
    and c.connection_state = 'active'
    and cal.enabled and cal.is_writable
  for update of c, cal;

  if v_connection_id is null then
    raise exception using
      errcode = '42501',
      message = 'google_event_destination_unavailable';
  end if;

  perform public.assert_google_event_change_allowed(p_family_event_id);

  select q.id into v_pending_create_id
  from public.google_sync_queue q
  where q.family_event_id = p_family_event_id
    and q.google_event_mapping_id = v_mapping.id
    and q.status = 'pending'
    and q.operation = 'create'
    and q.attempt_count = 0
    and not exists (
      select 1
      from public.google_sync_queue q_attempt
      where q_attempt.family_event_id = p_family_event_id
        and q_attempt.google_event_mapping_id = v_mapping.id
        and (q_attempt.status = 'processing' or q_attempt.attempt_count > 0)
    )
  for update;

  if v_pending_create_id is not null then
    -- This create has never been claimed, so Google cannot know its stable ID.
    -- It is safe to cancel the local event/mapping instead of queuing delete.
    delete from public.google_sync_queue where id = v_pending_create_id;
    delete from public.google_event_mappings where id = v_mapping.id;
    delete from public.events where id = p_family_event_id;
    return;
  end if;

  update public.events
  set sync_deleted_at = clock_timestamp()
  where id = p_family_event_id
    and sync_deleted_at is null;

  perform public.enqueue_google_event_change_internal(p_family_event_id, 'delete');
end;
$$;

create or replace function public.has_google_event_mapping(p_family_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.google_event_mappings m
    join public.events e on e.id = m.family_event_id
    where m.family_event_id = p_family_event_id
      and public.is_household_member(e.household_id)
  );
$$;

-- Preserve direct deletion for Family-Hub-only events, but Google-backed events
-- must first enter the recoverable pending-deletion state through the RPC above.
drop policy if exists events_delete on public.events;
create policy events_delete on public.events
for delete to authenticated
using (
  public.is_household_member(household_id)
  and not public.has_google_event_mapping(id)
);

create or replace function public.claim_google_sync_jobs(
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.google_sync_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 900));
begin
  return query
  with due_jobs as (
    select q.id
    from public.google_sync_queue q
    where (
      (q.status = 'pending' and q.next_attempt_at <= clock_timestamp())
      or (q.status = 'processing' and q.lease_expires_at <= clock_timestamp())
    )
      and (
        q.status = 'processing'
        or not exists (
          select 1
          from public.google_sync_queue active_job
          where active_job.family_event_id = q.family_event_id
            and active_job.status = 'processing'
        )
      )
    order by q.next_attempt_at, q.created_at
    for update skip locked
    limit v_limit
  )
  update public.google_sync_queue q
  set status = 'processing',
      attempt_count = q.attempt_count + 1,
      claim_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => v_lease_seconds),
      updated_at = clock_timestamp()
  from due_jobs
  where q.id = due_jobs.id
  returning q.*;
end;
$$;

create or replace function public.complete_google_sync_job(
  p_job_id uuid,
  p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.google_sync_queue
  set status = 'completed',
      lease_expires_at = null,
      claim_token = null,
      error_category = null,
      safe_error_message = null,
      updated_at = clock_timestamp()
  where id = p_job_id
    and status = 'processing'
    and claim_token = p_claim_token
    and lease_expires_at > clock_timestamp();

  if not found then
    raise exception 'Google sync job is not currently leased';
  end if;
end;
$$;

create or replace function public.fail_google_sync_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_error_category text,
  p_safe_error_message text,
  p_next_attempt_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.google_sync_queue
  set status = case
        when p_next_attempt_at is null then 'failed'
        when exists (
          select 1
          from public.google_sync_queue successor
          where successor.family_event_id = google_sync_queue.family_event_id
            and successor.status = 'pending'
        ) then 'superseded'
        else 'pending'
      end,
      next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at),
      lease_expires_at = null,
      claim_token = null,
      error_category = p_error_category,
      safe_error_message = p_safe_error_message,
      updated_at = clock_timestamp()
  where id = p_job_id
    and status = 'processing'
    and claim_token = p_claim_token
    and lease_expires_at > clock_timestamp();

  if not found then
    raise exception 'Google sync job is not currently leased';
  end if;
end;
$$;

revoke all on function public.get_google_sync_status() from public, anon, authenticated, service_role;
revoke all on function public.set_google_calendar_enabled(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.assert_google_event_change_allowed(uuid) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_google_event_change_internal(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_google_event_change(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.save_google_backed_event(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.request_google_event_delete(uuid) from public, anon, authenticated, service_role;
revoke all on function public.has_google_event_mapping(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_google_sync_jobs(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_google_sync_job(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_google_sync_job(uuid, uuid, text, text, timestamptz) from public, anon, authenticated, service_role;

grant execute on function public.get_google_sync_status() to authenticated;
grant execute on function public.set_google_calendar_enabled(uuid, boolean) to authenticated;
grant execute on function public.save_google_backed_event(jsonb) to authenticated;
grant execute on function public.request_google_event_delete(uuid) to authenticated;
grant execute on function public.has_google_event_mapping(uuid) to authenticated;
grant execute on function public.enqueue_google_event_change(uuid, text) to service_role;
grant execute on function public.claim_google_sync_jobs(integer, integer) to service_role;
grant execute on function public.complete_google_sync_job(uuid, uuid) to service_role;
grant execute on function public.fail_google_sync_job(uuid, uuid, text, text, timestamptz) to service_role;
