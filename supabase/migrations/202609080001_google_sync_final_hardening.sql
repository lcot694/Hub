-- Final forward-only hardening for already-installed Google sync deployments.

alter table public.events add column if not exists google_sync_updated_at timestamptz;
alter table public.events add column if not exists google_sync_version bigint;
update public.events
set google_sync_updated_at = coalesce(google_sync_updated_at, updated_at),
    google_sync_version = coalesce(google_sync_version, 1)
where google_sync_updated_at is null or google_sync_version is null;
alter table public.events alter column google_sync_updated_at set default clock_timestamp();
alter table public.events alter column google_sync_updated_at set not null;
alter table public.events alter column google_sync_version set default 1;
alter table public.events alter column google_sync_version set not null;
alter table public.events add constraint events_google_sync_version_positive check (google_sync_version > 0) not valid;
alter table public.events validate constraint events_google_sync_version_positive;

create or replace function public.track_google_owned_family_change()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  -- Person and bookkeeping-only changes intentionally do not influence conflict order.
  if new.title is distinct from old.title
    or new.event_date is distinct from old.event_date
    or new.start_time is distinct from old.start_time
    or new.end_time is distinct from old.end_time
    or new.all_day is distinct from old.all_day
    or new.recurrence is distinct from old.recurrence
    or new.recurrence_end is distinct from old.recurrence_end
    or new.sync_deleted_at is distinct from old.sync_deleted_at then
    new.google_sync_updated_at := clock_timestamp();
    new.google_sync_version := old.google_sync_version + 1;
  elsif new.person_id is distinct from old.person_id then
    return new;
  end if;
  return new;
end $$;
drop trigger if exists events_track_google_owned_change on public.events;
create trigger events_track_google_owned_change before update on public.events
for each row execute function public.track_google_owned_family_change();

create or replace function public.normalize_google_mapping_family_baseline()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if tg_op='INSERT' and new.last_family_updated_at is not null then
    select e.google_sync_updated_at into new.last_family_updated_at from public.events e where e.id=new.family_event_id;
  elsif tg_op='UPDATE' and new.last_family_updated_at is not null
    and new.last_family_updated_at is distinct from old.last_family_updated_at then
    select e.google_sync_updated_at into new.last_family_updated_at from public.events e where e.id=new.family_event_id;
  end if;
  return new;
end $$;
drop trigger if exists google_mapping_normalize_family_baseline on public.google_event_mappings;
create trigger google_mapping_normalize_family_baseline before insert or update of last_family_updated_at
on public.google_event_mappings for each row execute function public.normalize_google_mapping_family_baseline();

create or replace function public.assert_google_mapping_writable(p_family_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists(select 1 from public.google_event_mappings m
    where m.family_event_id=p_family_event_id and m.sync_state='read_only') then
    raise exception using errcode='42501', message='google_event_read_only';
  end if;
end $$;

-- Queue insertion is the transactional enforcement point shared by save/delete.
create or replace function public.enqueue_google_event_change_internal(p_family_event_id uuid,p_operation text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_mapping public.google_event_mappings%rowtype; v_operation text:=p_operation; v_queue_id uuid;
begin
  select * into v_mapping from public.google_event_mappings where family_event_id=p_family_event_id for update;
  if not found then return null; end if;
  perform public.assert_google_mapping_writable(p_family_event_id);
  if p_operation<>'delete' and exists(select 1 from public.events e where e.id=p_family_event_id and
    ((e.recurrence='monthly' and extract(day from e.event_date)>28)
      or (e.recurrence='yearly' and to_char(e.event_date,'MM-DD')='02-29'))) then
    raise exception using errcode='22023',message='google_recurrence_not_representable';
  end if;
  if exists(select 1 from public.events where id=p_family_event_id and sync_deleted_at is not null) then v_operation:='delete'; end if;
  update public.google_sync_queue set status='superseded',updated_at=clock_timestamp()
    where family_event_id=p_family_event_id and status='pending';
  insert into public.google_sync_queue(family_event_id,google_event_mapping_id,operation,status,next_attempt_at)
  values(p_family_event_id,v_mapping.id,v_operation,'pending',clock_timestamp()) returning id into v_queue_id;
  update public.google_event_mappings set sync_state='syncing',safe_error_message=null,updated_at=clock_timestamp()
    where id=v_mapping.id;
  return v_queue_id;
end $$;

create or replace function public.load_google_push_context(p_job_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  select jsonb_build_object('familyEvent',to_jsonb(e),'mapping',to_jsonb(m),'connection',to_jsonb(c),
    'calendar',to_jsonb(cal),'ownerUserId',c.user_id,'householdTimeZone',h.time_zone)
  into v_result
  from public.google_sync_queue q join public.events e on e.id=q.family_event_id
  join public.google_event_mappings m on m.id=q.google_event_mapping_id
  join public.google_connections c on c.id=m.google_connection_id
  join public.google_calendars cal on cal.id=m.google_calendar_id
  join public.households h on h.id=c.household_id
  join public.household_members member on member.household_id=c.household_id and member.user_id=c.user_id
  where q.id=p_job_id and q.claim_token=p_claim_token and q.status='processing'
    and q.lease_expires_at>clock_timestamp() and m.sync_state<>'read_only';
  if v_result is null then raise exception using message='Google sync job is not currently writable or leased'; end if;
  return v_result;
end $$;

create or replace function public.load_google_pull_mapping(p_calendar_id uuid,p_google_event_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('mapping',to_jsonb(m),'familyEvent',to_jsonb(e),
    'syncRelevantFamilyUpdatedAt',e.google_sync_updated_at)
  from public.google_event_mappings m join public.events e on e.id=m.family_event_id
  join public.google_calendars cal on cal.id=m.google_calendar_id
  join public.google_connections c on c.id=cal.google_connection_id
  join public.household_members member on member.household_id=c.household_id and member.user_id=c.user_id
  where m.google_calendar_id=p_calendar_id and m.google_event_id=p_google_event_id;
$$;

create or replace function public.complete_google_push_job(p_job_id uuid,p_claim_token uuid,p_completion jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_job public.google_sync_queue%rowtype; v_mapping public.google_event_mappings%rowtype;
  v_event public.events%rowtype; v_expected_event_version bigint;
  v_expected_mapping_updated_at timestamptz; v_has_successor boolean;
begin
  select * into v_job from public.google_sync_queue where id=p_job_id and claim_token=p_claim_token
    and status='processing' and lease_expires_at>clock_timestamp() for update;
  if not found then raise exception using message='Google sync job is not currently leased'; end if;
  select * into v_event from public.events e where e.id=v_job.family_event_id for update;
  select * into v_mapping from public.google_event_mappings m where m.id=v_job.google_event_mapping_id for update;
  v_expected_event_version := (p_completion->>'expectedEventVersion')::bigint;
  v_expected_mapping_updated_at := (p_completion->>'expectedMappingUpdatedAt')::timestamptz;
  select exists(select 1 from public.google_sync_queue successor where successor.family_event_id=v_job.family_event_id
    and successor.id<>v_job.id and successor.status in ('pending','processing') and successor.created_at>=v_job.created_at)
    into v_has_successor;
  if v_event.google_sync_version<>v_expected_event_version or v_mapping.updated_at<>v_expected_mapping_updated_at then
    update public.google_sync_queue set status=case when v_has_successor then 'superseded' else 'pending' end,
      claim_token=null,lease_expires_at=null,
      next_attempt_at=clock_timestamp(),error_category=null,safe_error_message=null,updated_at=clock_timestamp()
      where id=v_job.id;
    -- stale_google_push_completion: the durable queue, not this stale response,
    -- remains authoritative and will retry or run its newer successor.
    return;
  end if;
  if coalesce((p_completion->>'finalizeLocalDelete')::boolean,false) then
    if v_has_successor then
      update public.google_sync_queue set status='superseded',claim_token=null,lease_expires_at=null,updated_at=clock_timestamp() where id=v_job.id;
      return;
    end if;
    delete from public.google_event_mappings where id=v_mapping.id;
    delete from public.events where id=v_job.family_event_id;
    delete from public.google_sync_queue where id=v_job.id;
    return;
  end if;
  if p_completion ? 'reconcileFamilyEvent' then
    update public.events set title=coalesce(p_completion#>>'{reconcileFamilyEvent,title}',title),
      event_date=coalesce((p_completion#>>'{reconcileFamilyEvent,event_date}')::date,event_date),
      start_time=(p_completion#>>'{reconcileFamilyEvent,start_time}')::time,
      end_time=(p_completion#>>'{reconcileFamilyEvent,end_time}')::time,
      all_day=coalesce((p_completion#>>'{reconcileFamilyEvent,all_day}')::boolean,all_day),
      recurrence=coalesce(p_completion#>>'{reconcileFamilyEvent,recurrence}',recurrence),
      recurrence_end=(p_completion#>>'{reconcileFamilyEvent,recurrence_end}')::date,sync_deleted_at=null
      where id=v_event.id;
  end if;
  if p_completion ? 'unsupportedGoogleContent' then
    update public.google_event_mappings set google_etag=p_completion#>>'{unsupportedGoogleContent,google_etag}',
      google_updated_at=(p_completion#>>'{unsupportedGoogleContent,google_updated_at}')::timestamptz,
      sync_state='read_only',safe_error_message=p_completion#>>'{unsupportedGoogleContent,safe_error_message}',updated_at=clock_timestamp()
      where id=v_mapping.id;
  elsif p_completion ? 'mapping' then
    update public.google_event_mappings set google_event_id=coalesce(p_completion#>>'{mapping,google_event_id}',google_event_id),
      google_etag=p_completion#>>'{mapping,google_etag}',google_updated_at=(p_completion#>>'{mapping,google_updated_at}')::timestamptz,
      last_google_updated_at=(p_completion#>>'{mapping,last_google_updated_at}')::timestamptz,
      last_family_updated_at=(select google_sync_updated_at from public.events where id=v_event.id),
      sync_state=case when v_has_successor then 'syncing' else 'synced' end,safe_error_message=null,updated_at=clock_timestamp()
      where id=v_mapping.id;
  end if;
  update public.google_sync_queue set status=case when v_has_successor then 'superseded' else 'completed' end,
    claim_token=null,lease_expires_at=null,error_category=null,safe_error_message=null,updated_at=clock_timestamp() where id=v_job.id;
end $$;

create or replace function public.persist_google_refreshed_tokens(
  p_connection_id uuid,p_user_id uuid,p_google_account_id text,p_oauth_generation bigint,
  p_access_token_encrypted bytea,p_refresh_token_encrypted bytea,p_token_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.google_connections set access_token_encrypted=p_access_token_encrypted,
    refresh_token_encrypted=p_refresh_token_encrypted,token_expires_at=p_token_expires_at,updated_at=clock_timestamp()
  where id=p_connection_id and user_id=p_user_id and google_account_id=p_google_account_id
    and oauth_generation=p_oauth_generation and connection_state='active';
  return found;
end $$;

create or replace function public.requeue_google_failed_jobs(p_connection_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with eligible as (
    select q.id,e.sync_deleted_at from public.google_sync_queue q
    join public.google_event_mappings m on m.id=q.google_event_mapping_id
    join public.events e on e.id=q.family_event_id
    where m.google_connection_id=p_connection_id and q.status='failed' and m.sync_state<>'read_only'
      and not exists(select 1 from public.google_sync_queue newer where newer.family_event_id=q.family_event_id
        and newer.created_at>q.created_at and newer.status in ('pending','processing','completed'))
    for update of q
  ) update public.google_sync_queue q set operation=case when eligible.sync_deleted_at is not null then 'delete' else q.operation end,
    status='pending',next_attempt_at=clock_timestamp(),claim_token=null,lease_expires_at=null,
    error_category=null,safe_error_message=null,updated_at=clock_timestamp()
    from eligible where q.id=eligible.id;
  get diagnostics v_count=row_count; return v_count;
end $$;

create or replace function public.retry_google_event_sync(p_family_event_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_connection_id uuid;
begin
  select m.google_connection_id into v_connection_id from public.google_event_mappings m
  join public.events e on e.id=m.family_event_id where e.id=p_family_event_id
    and public.is_household_member(e.household_id) and m.sync_state<>'read_only' for update of m;
  if not found then return false; end if;
  perform public.requeue_google_failed_jobs(v_connection_id); return true;
end $$;

create or replace function public.requeue_google_jobs_after_reconnect()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.connection_state='active' and old.connection_state<>'active' then
    perform public.requeue_google_failed_jobs(new.id);
  end if;
  return new;
end $$;
drop trigger if exists google_connection_requeue_after_reconnect on public.google_connections;
create trigger google_connection_requeue_after_reconnect after update of connection_state on public.google_connections
for each row execute function public.requeue_google_jobs_after_reconnect();

-- Manual requests and a completed reconnect revive eligible failures without changing stable IDs.
create or replace function public.request_google_sync(p_user_id uuid,p_reason text)
returns table(connection_id uuid,accepted boolean) language plpgsql security definer set search_path = public as $$
declare v_connection public.google_connections%rowtype; v_now timestamptz:=clock_timestamp();
begin
  if p_reason not in ('manual','app_open') then raise exception using errcode='22023',message='invalid_sync_reason'; end if;
  select * into v_connection from public.google_connections c where c.user_id=p_user_id and c.connection_state='active'
    and exists(select 1 from public.household_members hm where hm.household_id=c.household_id and hm.user_id=p_user_id) for update;
  if not found then return; end if;
  connection_id:=v_connection.id; accepted:=p_reason='manual' or v_connection.last_sync_requested_at is null
    or v_connection.last_sync_requested_at<=v_now-interval '5 minutes';
  if accepted then
    if p_reason='manual' then perform public.requeue_google_failed_jobs(v_connection.id); end if;
    update public.google_connections set last_sync_requested_at=v_now,updated_at=v_now where id=v_connection.id;
  end if; return next;
end $$;

-- Candidate snapshots include only remotely-confirmed, quiescent mappings.
create or replace function public.begin_google_full_reconciliation(p_calendar_id uuid,p_run jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_generation bigint; v_scan_id uuid; v_started timestamptz:=clock_timestamp();
begin
  perform 1 from public.google_calendars where id=p_calendar_id and sync_token is not distinct from (p_run->>'expectedSyncToken')
    and updated_at=(p_run->>'expectedSyncVersion')::timestamptz and sync_claimed_until>clock_timestamp() for update;
  if not found then raise exception using message='Google pull lease changed'; end if;
  select coalesce(max(generation),0)+1 into v_generation from public.google_pull_scans where google_calendar_id=p_calendar_id;
  update public.google_calendars set sync_token=null where id=p_calendar_id;
  insert into public.google_pull_scans(google_calendar_id,generation,started_at,expected_sync_token,expected_sync_version,candidate_versions)
  select p_calendar_id,v_generation,v_started,p_run->>'expectedSyncToken',(p_run->>'expectedSyncVersion')::timestamptz,
    coalesce(jsonb_object_agg(m.google_event_id,jsonb_build_object('familyEventId',e.id,'mappingUpdatedAt',m.updated_at,
      'familyUpdatedAt',e.google_sync_updated_at,'familyVersion',e.google_sync_version,'lastFamilyUpdatedAt',m.last_family_updated_at)),'{}'::jsonb)
  from public.google_event_mappings m join public.events e on e.id=m.family_event_id
  where m.google_calendar_id=p_calendar_id and m.last_google_updated_at is not null
    and not exists(select 1 from public.google_sync_queue q where q.family_event_id=e.id and q.status in ('pending','processing','failed'))
  returning id into v_scan_id;
  return jsonb_build_object('scanId',v_scan_id,'generation',v_generation,'startedAt',v_started);
end $$;

create or replace function public.finish_google_full_reconciliation(p_calendar_id uuid,p_scan jsonb,p_next_sync_token text,p_cancellations jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_scan public.google_pull_scans%rowtype; v_candidate record; v_mapping public.google_event_mappings%rowtype; v_event public.events%rowtype; v_rows integer;
begin
  select * into v_scan from public.google_pull_scans where id=(p_scan->>'scanId')::uuid and google_calendar_id=p_calendar_id
    and generation=(p_scan->>'generation')::bigint for update;
  if not found then raise exception using message='Google reconciliation lease changed'; end if;
  perform 1 from public.google_calendars where id=p_calendar_id and sync_token is null and updated_at=v_scan.expected_sync_version
    and sync_claimed_until>clock_timestamp() for update;
  if not found then raise exception using message='Google pull lease changed'; end if;
  for v_candidate in select key,value from jsonb_each(v_scan.candidate_versions) loop
    if v_candidate.key=any(v_scan.seen_google_event_ids) then continue; end if;
    select * into v_mapping from public.google_event_mappings m where m.google_calendar_id=p_calendar_id
      and m.google_event_id=v_candidate.key and m.updated_at=(v_candidate.value->>'mappingUpdatedAt')::timestamptz for update;
    if not found then continue; end if;
    select * into v_event from public.events e where e.id=v_mapping.family_event_id for update;
    if v_event.google_sync_version=(v_candidate.value->>'familyVersion')::bigint
      and v_event.google_sync_updated_at=(v_candidate.value->>'familyUpdatedAt')::timestamptz
      and v_mapping.last_family_updated_at is not distinct from (v_candidate.value->>'lastFamilyUpdatedAt')::timestamptz then
      delete from public.google_event_mappings where id=v_mapping.id;
      delete from public.events where id=v_event.id and not exists(select 1 from public.google_event_mappings m where m.family_event_id=v_event.id);
    else
      update public.google_event_mappings set sync_state='needs_attention',safe_error_message='Family event changed while Google absence was reconciled',updated_at=clock_timestamp() where id=v_mapping.id;
      perform public.enqueue_google_event_change_internal(v_event.id,'update');
    end if;
  end loop;
  update public.google_calendars set sync_token=p_next_sync_token,last_synced_at=clock_timestamp(),sync_claimed_until=null,updated_at=clock_timestamp()
    where id=p_calendar_id and sync_token is null and updated_at=v_scan.expected_sync_version;
  get diagnostics v_rows=row_count; if v_rows<>1 then raise exception using message='Google pull lease changed'; end if;
  delete from public.google_pull_scans where id=v_scan.id;
end $$;

-- Status is transactionally derived from queue truth, including hidden tombstones.
drop function if exists public.get_google_sync_status(uuid);
create function public.get_google_sync_status(p_household_id uuid)
returns table(household_id uuid,family_event_id uuid,google_calendar_id uuid,calendar_name text,
  calendar_writable boolean,sync_state text,sync_error text,owner_user_id uuid,mapping_owned boolean,
  mapping_can_edit boolean,pending_deletion boolean)
language sql stable security definer set search_path = public as $$
  select e.household_id,e.id,cal.id,cal.display_name,cal.is_writable,
    case when m.sync_state='read_only' or not cal.is_writable then 'read_only'
      when c.connection_state<>'active' or not cal.enabled or exists(select 1 from public.google_sync_queue q where q.family_event_id=e.id and q.status='failed') then 'needs_attention'
      when exists(select 1 from public.google_sync_queue q where q.family_event_id=e.id and q.status in ('pending','processing')) then 'syncing'
      else 'synced' end,
    coalesce((select q.safe_error_message from public.google_sync_queue q where q.family_event_id=e.id and q.status='failed' order by q.updated_at desc limit 1),m.safe_error_message),
    c.user_id,c.user_id=auth.uid(),c.user_id=auth.uid() and cal.enabled and cal.is_writable and m.sync_state<>'read_only',
    e.sync_deleted_at is not null
  from public.events e join public.google_event_mappings m on m.family_event_id=e.id
  join public.google_connections c on c.id=m.google_connection_id join public.google_calendars cal on cal.id=m.google_calendar_id
  where e.household_id=p_household_id and public.is_household_member(e.household_id);
$$;

revoke all on function public.assert_google_mapping_writable(uuid) from public,anon,authenticated,service_role;
revoke all on function public.persist_google_refreshed_tokens(uuid,uuid,text,bigint,bytea,bytea,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.requeue_google_failed_jobs(uuid) from public,anon,authenticated,service_role;
revoke all on function public.retry_google_event_sync(uuid) from public,anon,authenticated,service_role;
revoke all on function public.load_google_push_context(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.load_google_pull_mapping(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.complete_google_push_job(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.begin_google_full_reconciliation(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.finish_google_full_reconciliation(uuid,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_google_refreshed_tokens(uuid,uuid,text,bigint,bytea,bytea,timestamptz) to service_role;
grant execute on function public.load_google_push_context(uuid,uuid) to service_role;
grant execute on function public.load_google_pull_mapping(uuid,text) to service_role;
grant execute on function public.complete_google_push_job(uuid,uuid,jsonb) to service_role;
grant execute on function public.begin_google_full_reconciliation(uuid,jsonb) to service_role;
grant execute on function public.finish_google_full_reconciliation(uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.retry_google_event_sync(uuid) to authenticated;
grant execute on function public.get_google_sync_status(uuid) to authenticated;
