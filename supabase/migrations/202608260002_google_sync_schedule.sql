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

create table if not exists public.google_pull_scans (
  id uuid primary key default gen_random_uuid(),
  google_calendar_id uuid not null references public.google_calendars(id) on delete cascade,
  generation bigint not null,
  started_at timestamptz not null default clock_timestamp(),
  candidate_versions jsonb not null default '{}'::jsonb,
  seen_google_event_ids text[] not null default '{}',
  unique (google_calendar_id, generation)
);
alter table public.google_pull_scans enable row level security;
revoke all on table public.google_pull_scans from public, anon, authenticated;

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
    and exists (
      select 1
      from public.household_members member
      where member.household_id = google_connections.household_id
        and member.user_id = p_user_id
    )
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

-- The worker adapters below expose only service-role transactional boundaries.
-- Secrets remain encrypted on google_connections and are returned solely to the
-- scheduled Edge Function, never through an authenticated browser RPC.
create or replace function public.load_google_push_context(p_job_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  select jsonb_build_object(
    'familyEvent', to_jsonb(e), 'mapping', to_jsonb(m),
    'connection', to_jsonb(c), 'calendar', to_jsonb(cal),
    'ownerUserId', c.user_id, 'householdTimeZone', h.time_zone
  ) into v_result
  from public.google_sync_queue q
  join public.events e on e.id = q.family_event_id
  join public.google_event_mappings m on m.id = q.google_event_mapping_id
  join public.google_connections c on c.id = m.google_connection_id
  join public.google_calendars cal on cal.id = m.google_calendar_id
  join public.households h on h.id = c.household_id
  join public.household_members member on member.household_id = c.household_id and member.user_id = c.user_id
  where q.id = p_job_id and q.claim_token = p_claim_token
    and q.status = 'processing' and q.lease_expires_at > clock_timestamp();
  if v_result is null then raise exception 'Google sync job is not currently leased'; end if;
  return v_result;
end $$;

create or replace function public.mark_google_connection_reconnect(p_connection_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.google_connections c set connection_state = 'reconnect_required', updated_at = clock_timestamp()
  where c.id = p_connection_id and c.user_id = p_user_id
    and exists (select 1 from public.household_members m where m.household_id = c.household_id and m.user_id = p_user_id);
end $$;

create or replace function public.complete_google_push_job(p_job_id uuid, p_claim_token uuid, p_completion jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_job public.google_sync_queue%rowtype; v_mapping public.google_event_mappings%rowtype;
begin
  select * into v_job from public.google_sync_queue where id = p_job_id and claim_token = p_claim_token
    and status = 'processing' and lease_expires_at > clock_timestamp() for update;
  if not found then raise exception 'Google sync job is not currently leased'; end if;
  select * into v_mapping from public.google_event_mappings where id = v_job.google_event_mapping_id for update;
  perform set_config('app.skip_google_event_queue', 'on', true);
  if coalesce((p_completion->>'finalizeLocalDelete')::boolean, false) then
    delete from public.google_event_mappings where id = v_mapping.id;
    delete from public.events where id = v_job.family_event_id;
    return;
  end if;
  if p_completion ? 'reconcileFamilyEvent' then
    update public.events set
      title = coalesce(p_completion#>>'{reconcileFamilyEvent,title}', title),
      event_date = coalesce((p_completion#>>'{reconcileFamilyEvent,event_date}')::date, event_date),
      start_time = (p_completion#>>'{reconcileFamilyEvent,start_time}')::time,
      end_time = (p_completion#>>'{reconcileFamilyEvent,end_time}')::time,
      all_day = coalesce((p_completion#>>'{reconcileFamilyEvent,all_day}')::boolean, all_day),
      recurrence = coalesce(p_completion#>>'{reconcileFamilyEvent,recurrence}', recurrence),
      recurrence_end = (p_completion#>>'{reconcileFamilyEvent,recurrence_end}')::date,
      sync_deleted_at = null
    where id = v_job.family_event_id;
  end if;
  if p_completion ? 'unsupportedGoogleContent' then
    update public.google_event_mappings set
      google_etag = p_completion#>>'{unsupportedGoogleContent,google_etag}',
      google_updated_at = (p_completion#>>'{unsupportedGoogleContent,google_updated_at}')::timestamptz,
      sync_state = 'read_only', safe_error_message = p_completion#>>'{unsupportedGoogleContent,safe_error_message}',
      updated_at = clock_timestamp() where id = v_mapping.id;
  elsif p_completion ? 'mapping' then
    update public.google_event_mappings set
      google_event_id = coalesce(p_completion#>>'{mapping,google_event_id}', google_event_id),
      google_etag = p_completion#>>'{mapping,google_etag}',
      google_updated_at = (p_completion#>>'{mapping,google_updated_at}')::timestamptz,
      last_google_updated_at = (p_completion#>>'{mapping,last_google_updated_at}')::timestamptz,
      last_family_updated_at = case when coalesce((p_completion->>'captureReconciledFamilyUpdatedAt')::boolean, false)
        then (select updated_at from public.events where id = v_job.family_event_id)
        else coalesce((p_completion#>>'{mapping,last_family_updated_at}')::timestamptz, last_family_updated_at) end,
      sync_state = 'synced', safe_error_message = null, updated_at = clock_timestamp()
    where id = v_mapping.id;
  end if;
  perform public.complete_google_sync_job(p_job_id, p_claim_token);
end $$;

create or replace function public.load_google_pull_mapping(p_calendar_id uuid, p_google_event_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'mapping', to_jsonb(m), 'familyEvent', to_jsonb(e),
    'syncRelevantFamilyUpdatedAt', coalesce((select max(q.updated_at) from public.google_sync_queue q
      where q.family_event_id = e.id and q.status in ('pending','processing')), m.last_family_updated_at)
  )
  from public.google_event_mappings m join public.events e on e.id = m.family_event_id
  join public.google_calendars cal on cal.id = m.google_calendar_id
  join public.google_connections c on c.id = cal.google_connection_id
  join public.household_members member on member.household_id = c.household_id and member.user_id = c.user_id
  where m.google_calendar_id = p_calendar_id and m.google_event_id = p_google_event_id;
$$;

create or replace function public.apply_google_pull_page(p_calendar_id uuid, p_changes jsonb, p_reconciliation jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_change jsonb; v_scan_id uuid := nullif(p_reconciliation#>>'{scan,scanId}', '')::uuid;
begin
  if not exists (select 1 from public.google_calendars cal join public.google_connections c on c.id=cal.google_connection_id
    join public.household_members member on member.household_id=c.household_id and member.user_id=c.user_id
    where cal.id=p_calendar_id and cal.sync_token is not distinct from (p_reconciliation#>>'{run,expectedSyncToken}')
      and cal.updated_at=(p_reconciliation#>>'{run,expectedSyncVersion}')::timestamptz)
  then raise exception 'Google pull lease changed'; end if;
  if v_scan_id is not null then update public.google_pull_scans set seen_google_event_ids =
    array(select distinct unnest(seen_google_event_ids || array(select jsonb_array_elements_text(p_reconciliation->'seenGoogleEventIds'))))
    where id=v_scan_id and google_calendar_id=p_calendar_id; end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    if v_change->>'kind' = 'import' then
      with inserted as (insert into public.events(household_id,person_id,title,event_date,start_time,end_time,all_day,recurrence,recurrence_end,created_by)
        select c.household_id, (v_change#>>'{familyEvent,person_id}')::uuid, v_change#>>'{familyEvent,title}',
          (v_change#>>'{familyEvent,event_date}')::date, (v_change#>>'{familyEvent,start_time}')::time,
          (v_change#>>'{familyEvent,end_time}')::time, (v_change#>>'{familyEvent,all_day}')::boolean,
          v_change#>>'{familyEvent,recurrence}', (v_change#>>'{familyEvent,recurrence_end}')::date, c.user_id
        from public.google_calendars cal join public.google_connections c on c.id=cal.google_connection_id where cal.id=p_calendar_id
        returning id, updated_at)
      insert into public.google_event_mappings(family_event_id,google_connection_id,google_calendar_id,google_event_id,google_etag,google_updated_at,last_family_updated_at,last_google_updated_at,sync_state)
        select i.id, cal.google_connection_id, cal.id, v_change->>'googleEventId', v_change#>>'{mapping,google_etag}',
          (v_change#>>'{mapping,google_updated_at}')::timestamptz, i.updated_at,
          (v_change#>>'{mapping,last_google_updated_at}')::timestamptz, v_change#>>'{mapping,sync_state}'
        from inserted i join public.google_calendars cal on cal.id=p_calendar_id
        on conflict (google_connection_id,google_calendar_id,google_event_id) do nothing;
    elsif v_change->>'kind' <> 'ignore' then
      update public.google_event_mappings set google_etag=v_change#>>'{mapping,google_etag}',
        google_updated_at=(v_change#>>'{mapping,google_updated_at}')::timestamptz,
        last_google_updated_at=(v_change#>>'{mapping,last_google_updated_at}')::timestamptz,
        sync_state=v_change#>>'{mapping,sync_state}', safe_error_message=v_change#>>'{mapping,safe_error_message}', updated_at=clock_timestamp()
      where google_calendar_id=p_calendar_id and google_event_id=v_change->>'googleEventId'
        and updated_at=(v_change#>>'{expected,mappingUpdatedAt}')::timestamptz;
      if v_change->>'kind' in ('update','cancel') then
        perform set_config('app.skip_google_event_queue','on',true);
        update public.events e set title=coalesce(v_change#>>'{familyEventPatch,title}',e.title),
          event_date=coalesce((v_change#>>'{familyEventPatch,event_date}')::date,e.event_date),
          start_time=(v_change#>>'{familyEventPatch,start_time}')::time, end_time=(v_change#>>'{familyEventPatch,end_time}')::time,
          all_day=coalesce((v_change#>>'{familyEventPatch,all_day}')::boolean,e.all_day),
          recurrence=coalesce(v_change#>>'{familyEventPatch,recurrence}',e.recurrence),
          recurrence_end=(v_change#>>'{familyEventPatch,recurrence_end}')::date,
          sync_deleted_at=case when v_change->>'kind'='cancel' then clock_timestamp() else null end
        where e.id=(v_change->>'familyEventId')::uuid and e.updated_at=(v_change#>>'{expected,familyUpdatedAt}')::timestamptz;
      end if;
    end if;
  end loop;
end $$;

create or replace function public.complete_google_incremental_pull(p_calendar_id uuid, p_run jsonb, p_next_sync_token text, p_cancellations jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.google_calendars set sync_token=p_next_sync_token,last_synced_at=clock_timestamp(),sync_claimed_until=null,updated_at=clock_timestamp()
  where id=p_calendar_id and sync_token is not distinct from (p_run->>'expectedSyncToken')
    and updated_at=(p_run->>'expectedSyncVersion')::timestamptz;
  if not found then raise exception 'Google pull lease changed'; end if;
  delete from public.google_event_mappings m using public.events e
    where m.family_event_id=e.id and m.google_calendar_id=p_calendar_id and e.id in
      (select value::uuid from jsonb_array_elements_text(p_cancellations));
  delete from public.events e where e.sync_deleted_at is not null and e.id in
      (select value::uuid from jsonb_array_elements_text(p_cancellations))
    and not exists(select 1 from public.google_event_mappings m where m.family_event_id=e.id);
end $$;

create or replace function public.begin_google_full_reconciliation(p_calendar_id uuid, p_run jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_generation bigint; v_scan_id uuid; v_started timestamptz:=clock_timestamp();
begin
  perform 1 from public.google_calendars where id=p_calendar_id
    and sync_token is not distinct from (p_run->>'expectedSyncToken')
    and updated_at=(p_run->>'expectedSyncVersion')::timestamptz for update;
  if not found then raise exception 'Google pull lease changed'; end if;
  select coalesce(max(generation),0)+1 into v_generation from public.google_pull_scans where google_calendar_id=p_calendar_id;
  insert into public.google_pull_scans(google_calendar_id,generation,started_at,candidate_versions)
  select p_calendar_id,v_generation,v_started,coalesce(jsonb_object_agg(m.google_event_id,
    jsonb_build_object('familyEventId',e.id,'mappingUpdatedAt',m.updated_at,'familyUpdatedAt',e.updated_at)),'{}'::jsonb)
  from public.google_event_mappings m join public.events e on e.id=m.family_event_id where m.google_calendar_id=p_calendar_id
  returning id into v_scan_id;
  return jsonb_build_object('scanId',v_scan_id,'generation',v_generation,'startedAt',v_started);
end $$;

create or replace function public.finish_google_full_reconciliation(p_calendar_id uuid, p_scan jsonb, p_next_sync_token text, p_cancellations jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_scan public.google_pull_scans%rowtype;
begin
  select * into v_scan from public.google_pull_scans where id=(p_scan->>'scanId')::uuid
    and google_calendar_id=p_calendar_id and generation=(p_scan->>'generation')::bigint for update;
  if not found then raise exception 'Google reconciliation lease changed'; end if;
  delete from public.google_event_mappings m using public.events e
    where m.family_event_id=e.id and m.google_calendar_id=p_calendar_id
      and not (m.google_event_id=any(v_scan.seen_google_event_ids))
      and m.updated_at=(v_scan.candidate_versions#>>array[m.google_event_id,'mappingUpdatedAt'])::timestamptz
      and e.updated_at=(v_scan.candidate_versions#>>array[m.google_event_id,'familyUpdatedAt'])::timestamptz;
  delete from public.events e where not exists(select 1 from public.google_event_mappings m where m.family_event_id=e.id)
    and e.id in (select (value->>'familyEventId')::uuid from jsonb_each(v_scan.candidate_versions));
  update public.google_calendars set sync_token=p_next_sync_token,last_synced_at=clock_timestamp(),sync_claimed_until=null,updated_at=clock_timestamp()
    where id=p_calendar_id;
  delete from public.google_pull_scans where id=v_scan.id;
end $$;

create or replace function public.abort_google_full_reconciliation(p_calendar_id uuid, p_scan jsonb)
returns void language sql security definer set search_path = public as $$
  delete from public.google_pull_scans where id=(p_scan->>'scanId')::uuid and google_calendar_id=p_calendar_id
    and generation=(p_scan->>'generation')::bigint;
$$;

create or replace function public.record_google_pull_failure(p_calendar_id uuid, p_error_category text, p_safe_error_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.google_calendars set sync_claimed_until=null,updated_at=clock_timestamp() where id=p_calendar_id;
  update public.google_event_mappings set sync_state='needs_attention',safe_error_message=p_safe_error_message,updated_at=clock_timestamp()
    where google_calendar_id=p_calendar_id;
end $$;

revoke all on function public.load_google_push_context(uuid,uuid) from public,anon,authenticated;
revoke all on function public.complete_google_push_job(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.load_google_pull_mapping(uuid,text) from public,anon,authenticated;
revoke all on function public.apply_google_pull_page(uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.complete_google_incremental_pull(uuid,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.begin_google_full_reconciliation(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finish_google_full_reconciliation(uuid,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.abort_google_full_reconciliation(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_google_pull_failure(uuid,text,text) from public,anon,authenticated;
revoke all on function public.mark_google_connection_reconnect(uuid,uuid) from public,anon,authenticated;
grant execute on function public.load_google_push_context(uuid,uuid) to service_role;
grant execute on function public.complete_google_push_job(uuid,uuid,jsonb) to service_role;
grant execute on function public.load_google_pull_mapping(uuid,text) to service_role;
grant execute on function public.apply_google_pull_page(uuid,jsonb,jsonb) to service_role;
grant execute on function public.complete_google_incremental_pull(uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.begin_google_full_reconciliation(uuid,jsonb) to service_role;
grant execute on function public.finish_google_full_reconciliation(uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.abort_google_full_reconciliation(uuid,jsonb) to service_role;
grant execute on function public.record_google_pull_failure(uuid,text,text) to service_role;
grant execute on function public.mark_google_connection_reconnect(uuid,uuid) to service_role;

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
    join public.household_members member
      on member.household_id = conn.household_id
     and member.user_id = conn.user_id
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
  join public.household_members member
    on member.household_id = conn.household_id
   and member.user_id = conn.user_id
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
