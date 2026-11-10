-- Task 7 hardening: one account per adult and atomic calendar settings writes.
-- Existing installs must explicitly remediate duplicate accounts before retrying.
-- This deliberately leaves calendars, mappings, and queue rows untouched.
do $$
begin
  if exists (
    select 1 from public.google_connections
    group by user_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'google_connection_duplicate_users',
      detail = 'Inspect duplicate user_id rows and explicitly disconnect the unwanted connection before retrying.';
  end if;
end;
$$;

create unique index google_connections_one_account_per_user_idx
  on public.google_connections(user_id);

create or replace function public.replace_google_calendar_snapshot(
  p_connection_id uuid,
  p_user_id uuid,
  p_calendars jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.google_connections
    where id = p_connection_id and user_id = p_user_id
  ) then
    raise exception 'Google calendar is not available to this user';
  end if;
  if jsonb_typeof(p_calendars) <> 'array' or exists (
    select 1 from jsonb_array_elements(p_calendars) item
    where jsonb_typeof(item->'google_calendar_id') <> 'string'
      or jsonb_typeof(item->'display_name') <> 'string'
      or coalesce(item->>'google_access_role', '') not in ('freeBusyReader','reader','writer','owner')
  ) or (select count(*) from jsonb_array_elements(p_calendars)) <> (
    select count(distinct item->>'google_calendar_id') from jsonb_array_elements(p_calendars) item
  ) then
    raise exception 'Google calendar snapshot is invalid';
  end if;

  insert into public.google_calendars (
    google_connection_id, google_calendar_id, display_name, time_zone, google_access_role
  )
  select p_connection_id, item->>'google_calendar_id', item->>'display_name',
    nullif(item->>'time_zone', ''), item->>'google_access_role'
  from jsonb_array_elements(p_calendars) item
  on conflict (google_connection_id, google_calendar_id) do update
  set display_name = excluded.display_name,
      time_zone = excluded.time_zone,
      google_access_role = excluded.google_access_role,
      updated_at = clock_timestamp();

  update public.google_calendars cal
  set enabled = false,
      updated_at = clock_timestamp()
  where cal.google_connection_id = p_connection_id
    and not exists (
      select 1 from jsonb_array_elements(p_calendars) item
      where item->>'google_calendar_id' = cal.google_calendar_id
    );
end;
$$;

create or replace function public.set_google_calendar_selection(
  p_connection_id uuid,
  p_user_id uuid,
  p_person_id uuid,
  p_calendars jsonb
)
returns table (
  id uuid, household_id uuid, person_id uuid, display_email text, connection_state text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.google_connections c
    join public.household_members member on member.household_id = c.household_id
    where c.id = p_connection_id and c.user_id = p_user_id and member.user_id = p_user_id
  ) or not exists (
    select 1 from public.people p
    join public.google_connections c on c.household_id = p.household_id
    where c.id = p_connection_id and c.user_id = p_user_id and p.id = p_person_id
  ) then
    raise exception 'Google calendar is not available to this user';
  end if;
  if jsonb_typeof(p_calendars) <> 'array' or exists (
    select 1 from jsonb_array_elements(p_calendars) item
    where jsonb_typeof(item->'googleCalendarId') <> 'string'
      or jsonb_typeof(item->'enabled') <> 'boolean'
  ) or (select count(*) from jsonb_array_elements(p_calendars)) <> (
    select count(distinct item->>'googleCalendarId') from jsonb_array_elements(p_calendars) item
  ) or exists (
    select 1 from jsonb_array_elements(p_calendars) item
    where not exists (
      select 1 from public.google_calendars cal
      where cal.google_connection_id = p_connection_id
        and cal.google_calendar_id = item->>'googleCalendarId'
    )
  ) then
    raise exception 'Google calendar is not available to this user';
  end if;

  update public.google_connections c
  set person_id = p_person_id, updated_at = clock_timestamp()
  where c.id = p_connection_id and c.user_id = p_user_id;

  update public.google_calendars cal
  set enabled = (item->>'enabled')::boolean,
      updated_at = clock_timestamp()
  from jsonb_array_elements(p_calendars) item
  where cal.google_connection_id = p_connection_id
    and cal.google_calendar_id = item->>'googleCalendarId';

  return query
  select c.id, c.household_id, c.person_id, c.display_email, c.connection_state
  from public.google_connections c
  where c.id = p_connection_id and c.user_id = p_user_id;
end;
$$;

create or replace function public.mark_google_connection_reconnect_required(
  p_connection_id uuid,
  p_user_id uuid
)
returns table (
  id uuid, household_id uuid, person_id uuid, display_email text, connection_state text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.google_connections
    where id = p_connection_id and user_id = p_user_id
  ) then
    raise exception 'Google calendar is not available to this user';
  end if;
  update public.google_connections c
  set connection_state = 'reconnect_required',
      last_error = null,
      updated_at = clock_timestamp()
  where c.id = p_connection_id and c.user_id = p_user_id;
  return query
  select c.id, c.household_id, c.person_id, c.display_email, c.connection_state
  from public.google_connections c
  where c.id = p_connection_id and c.user_id = p_user_id;
end;
$$;

revoke all on function public.replace_google_calendar_snapshot(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_google_calendar_selection(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.mark_google_connection_reconnect_required(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.replace_google_calendar_snapshot(uuid, uuid, jsonb) to service_role;
grant execute on function public.set_google_calendar_selection(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.mark_google_connection_reconnect_required(uuid, uuid) to service_role;
