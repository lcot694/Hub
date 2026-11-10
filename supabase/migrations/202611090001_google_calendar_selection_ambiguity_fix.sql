-- Qualify google_connections columns that collide with RETURNS TABLE output
-- variables in PL/pgSQL. This forward migration repairs existing deployments;
-- the original hardening migration carries the same fix for fresh installs.
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

revoke all on function public.set_google_calendar_selection(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_google_calendar_selection(uuid, uuid, uuid, jsonb)
  to service_role;
