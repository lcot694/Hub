-- A deliberately narrow household-readable surface for realtime sync-state UI.
-- It excludes Google resource identifiers, ETags, account email, and credentials.
create table public.google_event_sync_status (
  family_event_id uuid primary key references public.events(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  google_calendar_id uuid not null,
  calendar_name text not null,
  calendar_writable boolean not null,
  connection_active boolean not null,
  sync_state text not null check (sync_state in ('synced','syncing','needs_attention','read_only')),
  sync_error text,
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.google_event_sync_status enable row level security;
create policy google_event_sync_status_select on public.google_event_sync_status
for select to authenticated using (public.is_household_member(household_id));
revoke all on public.google_event_sync_status from public, anon, authenticated;
grant select on public.google_event_sync_status to authenticated;

create or replace function public.refresh_google_event_sync_status(p_family_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.google_event_sync_status (
    family_event_id, household_id, owner_user_id, google_calendar_id,
    calendar_name, calendar_writable, connection_active, sync_state, sync_error, updated_at
  )
  select m.family_event_id, e.household_id, c.user_id, cal.id,
    cal.display_name, cal.is_writable,
    c.connection_state = 'active',
    case
      when m.sync_state = 'read_only' or not cal.is_writable then 'read_only'
      when c.connection_state <> 'active' or not cal.enabled then 'needs_attention'
      else m.sync_state
    end,
    case
      when m.sync_state = 'read_only' or not cal.is_writable then coalesce(m.safe_error_message, 'Google calendar is read-only')
      when c.connection_state <> 'active' then coalesce(m.safe_error_message, 'Google Calendar connection needs attention')
      when not cal.enabled then coalesce(m.safe_error_message, 'Google calendar is disabled')
      else m.safe_error_message
    end,
    clock_timestamp()
  from public.google_event_mappings m
  join public.events e on e.id = m.family_event_id
  join public.google_connections c on c.id = m.google_connection_id
  join public.google_calendars cal on cal.id = m.google_calendar_id
  where m.family_event_id = p_family_event_id
  on conflict (family_event_id) do update set
    household_id=excluded.household_id, owner_user_id=excluded.owner_user_id,
    google_calendar_id=excluded.google_calendar_id, calendar_name=excluded.calendar_name,
    calendar_writable=excluded.calendar_writable, connection_active=excluded.connection_active,
    sync_state=excluded.sync_state, sync_error=excluded.sync_error, updated_at=excluded.updated_at;

  if not found then
    delete from public.google_event_sync_status where family_event_id = p_family_event_id;
  end if;
end;
$$;
revoke all on function public.refresh_google_event_sync_status(uuid) from public, anon, authenticated;

create or replace function public.google_event_mapping_status_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_google_event_sync_status(coalesce(new.family_event_id, old.family_event_id));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.google_event_mapping_status_trigger() from public, anon, authenticated;

create trigger google_event_mapping_status_refresh
after insert or update or delete on public.google_event_mappings
for each row execute function public.google_event_mapping_status_trigger();

create or replace function public.google_calendar_status_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_event_id uuid;
begin
  for v_event_id in select family_event_id from public.google_event_mappings where google_calendar_id=new.id loop
    perform public.refresh_google_event_sync_status(v_event_id);
  end loop;
  return new;
end;
$$;
revoke all on function public.google_calendar_status_trigger() from public, anon, authenticated;
create trigger google_calendar_status_refresh
after update of display_name, enabled, google_access_role on public.google_calendars
for each row execute function public.google_calendar_status_trigger();

create or replace function public.google_connection_status_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_event_id uuid;
begin
  for v_event_id in select family_event_id from public.google_event_mappings where google_connection_id=new.id loop
    perform public.refresh_google_event_sync_status(v_event_id);
  end loop;
  return new;
end;
$$;
revoke all on function public.google_connection_status_trigger() from public, anon, authenticated;
create trigger google_connection_status_refresh
after update of connection_state, user_id on public.google_connections
for each row execute function public.google_connection_status_trigger();

insert into public.google_event_sync_status (
  family_event_id, household_id, owner_user_id, google_calendar_id,
  calendar_name, calendar_writable, connection_active, sync_state, sync_error, updated_at
)
select m.family_event_id, e.household_id, c.user_id, cal.id, cal.display_name,
  cal.is_writable, c.connection_state='active',
  case
    when m.sync_state = 'read_only' or not cal.is_writable then 'read_only'
    when c.connection_state <> 'active' or not cal.enabled then 'needs_attention'
    else m.sync_state
  end,
  case
    when m.sync_state = 'read_only' or not cal.is_writable then coalesce(m.safe_error_message, 'Google calendar is read-only')
    when c.connection_state <> 'active' then coalesce(m.safe_error_message, 'Google Calendar connection needs attention')
    when not cal.enabled then coalesce(m.safe_error_message, 'Google calendar is disabled')
    else m.safe_error_message
  end,
  clock_timestamp()
from public.google_event_mappings m
join public.events e on e.id=m.family_event_id
join public.google_connections c on c.id=m.google_connection_id
join public.google_calendars cal on cal.id=m.google_calendar_id;

drop function if exists public.get_google_sync_status();
create function public.get_google_sync_status(p_household_id uuid)
returns table (
  household_id uuid, family_event_id uuid, google_calendar_id uuid,
  calendar_name text, calendar_writable boolean, sync_state text, sync_error text,
  owner_user_id uuid, mapping_owned boolean, mapping_can_edit boolean
)
language sql stable security definer set search_path = public as $$
  select e.household_id, m.family_event_id, cal.id, cal.display_name,
    cal.is_writable,
    case
      when m.sync_state = 'read_only' or not cal.is_writable then 'read_only'
      when c.connection_state <> 'active' or not cal.enabled then 'needs_attention'
      else m.sync_state
    end,
    case
      when m.sync_state = 'read_only' or not cal.is_writable then coalesce(m.safe_error_message, 'Google calendar is read-only')
      when c.connection_state <> 'active' then coalesce(m.safe_error_message, 'Google Calendar connection needs attention')
      when not cal.enabled then coalesce(m.safe_error_message, 'Google calendar is disabled')
      else m.safe_error_message
    end,
    c.user_id,
    c.user_id = auth.uid() as mapping_owned,
    c.user_id = auth.uid() and c.connection_state='active'
      and cal.enabled and cal.is_writable and m.sync_state <> 'read_only' as mapping_can_edit
  from public.google_event_mappings m
  join public.events e on e.id=m.family_event_id
  join public.google_connections c on c.id=m.google_connection_id
  join public.google_calendars cal on cal.id=m.google_calendar_id
  where e.household_id = p_household_id
    and public.is_household_member(e.household_id);
$$;
revoke all on function public.get_google_sync_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_google_sync_status(uuid) to authenticated;

alter publication supabase_realtime add table public.google_event_sync_status;
