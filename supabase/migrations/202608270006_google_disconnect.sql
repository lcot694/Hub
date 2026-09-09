create or replace function public.disconnect_google_calendar(
  p_connection_id uuid,
  p_user_id uuid,
  p_mode text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_ids uuid[];
begin
  if p_mode not in ('keep_local', 'remove_local') then
    raise exception using errcode = '22023', message = 'google_disconnect_invalid_mode';
  end if;

  perform 1
  from public.google_connections c
  where c.id = p_connection_id
    and c.user_id = p_user_id
  for update;

  if not found then
    return false;
  end if;

  select coalesce(array_agg(m.family_event_id), array[]::uuid[])
  into v_event_ids
  from public.google_event_mappings m
  where m.google_connection_id = p_connection_id;

  delete from public.google_sync_queue q
  using public.google_event_mappings m
  where q.google_event_mapping_id = m.id
    and m.google_connection_id = p_connection_id;

  delete from public.google_event_mappings m
  where m.google_connection_id = p_connection_id;

  delete from public.google_calendars cal
  where cal.google_connection_id = p_connection_id;

  if p_mode = 'remove_local' then
    delete from public.events e
    where e.id = any(v_event_ids)
      and not exists (
        select 1 from public.google_event_mappings remaining
        where remaining.family_event_id = e.id
      );
  end if;

  update public.google_connections c
  set access_token_encrypted = null,
      refresh_token_encrypted = null,
      token_expires_at = null,
      connection_state = 'disconnected',
      last_error = null,
      disconnected_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where c.id = p_connection_id
    and c.user_id = p_user_id;

  return true;
end;
$$;

revoke all on function public.disconnect_google_calendar(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.disconnect_google_calendar(uuid, uuid, text)
  to service_role;
