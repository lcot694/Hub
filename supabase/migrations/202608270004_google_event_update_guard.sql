-- Direct browser updates may only reassign the person on a mapped event owned
-- by that adult. Google-owned changes continue through the atomic RPC, while
-- service-role worker updates and flagged RPC internals retain their paths.
create or replace function public.guard_direct_mapped_event_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_user_id uuid;
begin
  if coalesce(auth.role(), '') = 'service_role'
    or current_setting('app.skip_google_event_queue', true) = 'on' then
    return new;
  end if;

  select c.user_id into v_owner_user_id
  from public.google_event_mappings m
  join public.google_connections c on c.id = m.google_connection_id
  where m.family_event_id = old.id;

  -- Family-Hub-only events preserve their existing direct update path.
  if not found then
    return new;
  end if;

  if auth.uid() is null or v_owner_user_id <> auth.uid() then
    raise exception using errcode='42501', message='google_event_forbidden';
  end if;

  if new.id is distinct from old.id
    or new.household_id is distinct from old.household_id
    or new.created_by is distinct from old.created_by
    or new.title is distinct from old.title
    or new.event_date is distinct from old.event_date
    or new.start_time is distinct from old.start_time
    or new.end_time is distinct from old.end_time
    or new.all_day is distinct from old.all_day
    or new.recurrence is distinct from old.recurrence
    or new.recurrence_end is distinct from old.recurrence_end
    or new.sync_deleted_at is distinct from old.sync_deleted_at
    or new.updated_at is distinct from old.updated_at then
    raise exception using errcode='42501', message='google_event_rpc_required';
  end if;

  if new.person_id is distinct from old.person_id
    and new.person_id is not null
    and not exists (
      select 1 from public.people p
      where p.id = new.person_id and p.household_id = old.household_id
    ) then
    raise exception using errcode='22023', message='google_event_invalid_person';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_direct_mapped_event_update() from public, anon, authenticated, service_role;
drop trigger if exists events_guard_mapped_updates on public.events;
create trigger events_guard_mapped_updates
before update on public.events
for each row execute function public.guard_direct_mapped_event_update();
