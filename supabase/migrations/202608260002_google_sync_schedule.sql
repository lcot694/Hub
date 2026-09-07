-- Google synchronization orchestration.
-- Before applying, create Vault secrets named exactly:
--   project_url                 (for example https://PROJECT.supabase.co)
--   google_sync_cron_secret     (a high-entropy bearer credential)

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

alter table public.google_connections
  add column if not exists last_sync_requested_at timestamptz;

alter table public.google_calendars
  add column if not exists sync_claimed_until timestamptz;

create or replace function public.request_google_sync(
  p_user_id uuid,
  p_reason text
)
returns table (connection_id uuid, accepted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection public.google_connections%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_reason not in ('manual', 'app_open') then
    raise exception using errcode = '22023', message = 'invalid_sync_reason';
  end if;

  select * into v_connection
  from public.google_connections
  where user_id = p_user_id
    and connection_state = 'active'
  for update;

  if not found then return; end if;

  connection_id := v_connection.id;
  accepted := p_reason = 'manual'
    or v_connection.last_sync_requested_at is null
    or v_connection.last_sync_requested_at <= v_now - interval '5 minutes';

  if accepted then
    update public.google_connections
    set last_sync_requested_at = v_now,
        updated_at = v_now
    where id = v_connection.id;
  end if;
  return next;
end;
$$;

create or replace function public.claim_google_sync_calendars(p_limit integer)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
begin
  return query
  with due as (
    select cal.id
    from public.google_calendars cal
    join public.google_connections conn on conn.id = cal.google_connection_id
    where cal.enabled
      and conn.connection_state = 'active'
      and (cal.sync_claimed_until is null or cal.sync_claimed_until <= clock_timestamp())
      and (
        cal.last_synced_at is null
        or cal.last_synced_at <= clock_timestamp() - interval '5 minutes'
        or conn.last_sync_requested_at > coalesce(cal.last_synced_at, '-infinity'::timestamptz)
      )
    order by coalesce(cal.last_synced_at, '-infinity'::timestamptz), cal.created_at
    for update of cal skip locked
    limit v_limit
  ), claimed as (
    update public.google_calendars cal
    set sync_claimed_until = clock_timestamp() + interval '5 minutes',
        updated_at = clock_timestamp()
    from due
    where cal.id = due.id
    returning cal.*
  )
  select jsonb_build_object(
    'id', cal.id,
    'google_connection_id', cal.google_connection_id,
    'google_calendar_id', cal.google_calendar_id,
    'enabled', cal.enabled,
    'is_writable', cal.is_writable,
    'sync_token', cal.sync_token,
    'sync_version', cal.updated_at::text,
    'time_zone', cal.time_zone,
    'ownerUserId', conn.user_id,
    'householdTimeZone', household.time_zone,
    'connection', to_jsonb(conn)
  )
  from claimed cal
  join public.google_connections conn on conn.id = cal.google_connection_id
  join public.households household on household.id = conn.household_id;
end;
$$;

revoke all on function public.request_google_sync(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_google_sync_calendars(integer) from public, anon, authenticated, service_role;
grant execute on function public.request_google_sync(uuid, text) to service_role;
grant execute on function public.claim_google_sync_calendars(integer) to service_role;

-- Idempotently replace the schedule. The request reads both URL and bearer
-- value from Vault at execution time; neither credential is embedded here.
do $$
declare
  v_existing bigint;
begin
  select jobid into v_existing from cron.job where jobname = 'family-hub-google-sync';
  if v_existing is not null then perform cron.unschedule(v_existing); end if;
  perform cron.schedule(
    'family-hub-google-sync',
    '*/5 * * * *',
    $schedule$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/google-sync-scheduled',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'google_sync_cron_secret')
        ),
        body := '{}'::jsonb
      );
    $schedule$
  );
end;
$$;
