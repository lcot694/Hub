-- Qualify google_connections columns that collide with RETURNS TABLE output
-- variables when an expired Google authorization is marked for reconnect.
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
    select 1 from public.google_connections c
    where c.id = p_connection_id and c.user_id = p_user_id
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

revoke all on function public.mark_google_connection_reconnect_required(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_google_connection_reconnect_required(uuid, uuid)
  to service_role;
