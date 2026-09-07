-- Forward upgrade for databases that already installed 202608260001/002.
-- These definitions are the current implementations with all custom-GUC
-- suppression removed. Trusted write paths are identified by effective role.

create or replace function public.events_enqueue_google_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    perform public.assert_google_event_change_allowed(new.id);
    perform public.enqueue_google_event_change_internal(new.id, 'create');
  elsif new.title is distinct from old.title or new.event_date is distinct from old.event_date
    or new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time
    or new.all_day is distinct from old.all_day or new.recurrence is distinct from old.recurrence
    or new.recurrence_end is distinct from old.recurrence_end then
    perform public.assert_google_event_change_allowed(new.id);
    perform public.enqueue_google_event_change_internal(new.id, 'update');
  end if;
  return new;
end $$;

drop trigger if exists events_enqueue_google_change on public.events;
create trigger events_enqueue_google_change after insert or update on public.events
for each row execute function public.events_enqueue_google_change();

create or replace function public.save_google_backed_event(p_event jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household_id uuid; v_calendar_id uuid; v_event_id uuid; v_person_id uuid; v_connection_id uuid;
  v_title text; v_event_date date; v_start_time time; v_end_time time; v_all_day boolean;
  v_recurrence text; v_recurrence_end date; v_existing_event public.events%rowtype;
  v_mapping public.google_event_mappings%rowtype; v_google_changed boolean := false;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='google_event_not_authenticated'; end if;
  if jsonb_typeof(p_event) <> 'object' or not (p_event ? 'household_id') or not (p_event ? 'google_calendar_id')
    or not (p_event ? 'title') or not (p_event ? 'event_date') or not (p_event ? 'all_day')
    or not (p_event ? 'recurrence') or jsonb_typeof(p_event->'household_id') <> 'string'
    or jsonb_typeof(p_event->'google_calendar_id') <> 'string'
    or (p_event ? 'id' and jsonb_typeof(p_event->'id') <> 'string')
    or (p_event ? 'person_id' and jsonb_typeof(p_event->'person_id') not in ('string','null'))
    or jsonb_typeof(p_event->'title') <> 'string' or jsonb_typeof(p_event->'event_date') <> 'string'
    or (p_event ? 'start_time' and jsonb_typeof(p_event->'start_time') not in ('string','null'))
    or (p_event ? 'end_time' and jsonb_typeof(p_event->'end_time') not in ('string','null'))
    or jsonb_typeof(p_event->'all_day') <> 'boolean' or jsonb_typeof(p_event->'recurrence') <> 'string'
    or (p_event ? 'recurrence_end' and jsonb_typeof(p_event->'recurrence_end') not in ('string','null'))
  then raise exception using errcode='22023',message='google_event_invalid_payload'; end if;
  begin
    v_household_id := (p_event->>'household_id')::uuid; v_calendar_id := (p_event->>'google_calendar_id')::uuid;
    v_event_id := nullif(p_event->>'id','')::uuid; v_person_id := nullif(p_event->>'person_id','')::uuid;
    v_event_date := (p_event->>'event_date')::date; v_start_time := nullif(p_event->>'start_time','')::time;
    v_end_time := nullif(p_event->>'end_time','')::time; v_all_day := coalesce((p_event->>'all_day')::boolean,false);
    v_recurrence := coalesce(p_event->>'recurrence','none'); v_recurrence_end := nullif(p_event->>'recurrence_end','')::date;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='22023',message='google_event_invalid_payload';
  end;
  v_title := btrim(coalesce(p_event->>'title',''));
  if v_title='' or v_recurrence not in ('none','daily','weekly','monthly','yearly') then
    raise exception using errcode='22023',message='google_event_invalid_payload'; end if;
  if not public.is_household_member(v_household_id) then raise exception using errcode='42501',message='google_event_forbidden'; end if;
  if v_person_id is not null and not exists(select 1 from public.people p where p.id=v_person_id and p.household_id=v_household_id)
    then raise exception using errcode='22023',message='google_event_invalid_person'; end if;
  if v_event_id is null then
    select c.id into v_connection_id from public.google_connections c
    join public.google_calendars cal on cal.google_connection_id=c.id
    where cal.id=v_calendar_id and c.user_id=auth.uid() and c.household_id=v_household_id
      and c.connection_state='active' and cal.enabled and cal.is_writable for update of c,cal;
    if v_connection_id is null then raise exception using errcode='42501',message='google_event_destination_unavailable'; end if;
    insert into public.events(household_id,person_id,title,event_date,start_time,end_time,all_day,recurrence,recurrence_end,created_by)
    values(v_household_id,v_person_id,v_title,v_event_date,v_start_time,v_end_time,v_all_day,v_recurrence,v_recurrence_end,auth.uid()) returning id into v_event_id;
    insert into public.google_event_mappings(family_event_id,google_connection_id,google_calendar_id,google_event_id,sync_state)
    values(v_event_id,v_connection_id,v_calendar_id,'fh'||replace(v_event_id::text,'-',''),'syncing');
    perform public.enqueue_google_event_change_internal(v_event_id,'create'); return v_event_id;
  end if;
  select e.* into v_existing_event from public.events e where e.id=v_event_id and e.household_id=v_household_id for update of e;
  if not found then raise exception using errcode='P0002',message='google_event_not_found'; end if;
  select m.* into v_mapping from public.google_event_mappings m where m.family_event_id=v_event_id for update of m;
  if not found then raise exception using errcode='42501',message='google_event_destination_unavailable'; end if;
  select c.id into v_connection_id from public.google_connections c join public.google_calendars cal on cal.google_connection_id=c.id
  where c.id=v_mapping.google_connection_id and cal.id=v_calendar_id and v_mapping.google_calendar_id=v_calendar_id
    and c.user_id=auth.uid() and c.household_id=v_household_id and c.connection_state='active'
    and cal.enabled and cal.is_writable for update of c,cal;
  if v_connection_id is null then raise exception using errcode='42501',message='google_event_destination_unavailable'; end if;
  v_google_changed := v_existing_event.title is distinct from v_title or v_existing_event.event_date is distinct from v_event_date
    or v_existing_event.start_time is distinct from v_start_time or v_existing_event.end_time is distinct from v_end_time
    or v_existing_event.all_day is distinct from v_all_day or v_existing_event.recurrence is distinct from v_recurrence
    or v_existing_event.recurrence_end is distinct from v_recurrence_end;
  update public.events set person_id=v_person_id,title=v_title,event_date=v_event_date,start_time=v_start_time,
    end_time=v_end_time,all_day=v_all_day,recurrence=v_recurrence,recurrence_end=v_recurrence_end where id=v_event_id;
  if v_google_changed then perform public.enqueue_google_event_change_internal(v_event_id,'update'); end if;
  return v_event_id;
end $$;

create or replace function public.request_google_event_delete(p_family_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_event public.events%rowtype; v_mapping public.google_event_mappings%rowtype;
  v_connection_id uuid; v_pending_create_id uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='google_event_not_authenticated'; end if;
  select e.* into v_event from public.events e where e.id=p_family_event_id
    and public.is_household_member(e.household_id) for update of e;
  if not found then raise exception using errcode='42501',message='google_event_forbidden'; end if;
  select m.* into v_mapping from public.google_event_mappings m where m.family_event_id=p_family_event_id for update of m;
  if not found then raise exception using errcode='42501',message='google_event_destination_unavailable'; end if;
  select c.id into v_connection_id from public.google_connections c join public.google_calendars cal on cal.google_connection_id=c.id
  where c.id=v_mapping.google_connection_id and cal.id=v_mapping.google_calendar_id and c.user_id=auth.uid()
    and c.connection_state='active' and cal.enabled and cal.is_writable for update of c,cal;
  if v_connection_id is null then raise exception using errcode='42501',message='google_event_destination_unavailable'; end if;
  perform public.assert_google_event_change_allowed(p_family_event_id);
  select q.id into v_pending_create_id from public.google_sync_queue q where q.family_event_id=p_family_event_id
    and q.google_event_mapping_id=v_mapping.id and q.status='pending' and q.operation='create' and q.attempt_count=0
    and not exists(select 1 from public.google_sync_queue qa where qa.family_event_id=p_family_event_id
      and qa.google_event_mapping_id=v_mapping.id and (qa.status='processing' or qa.attempt_count>0)) for update;
  if v_pending_create_id is not null then
    delete from public.google_sync_queue where id=v_pending_create_id;
    delete from public.google_event_mappings where id=v_mapping.id;
    delete from public.events where id=p_family_event_id; return;
  end if;
  update public.events set sync_deleted_at=clock_timestamp() where id=p_family_event_id and sync_deleted_at is null;
  perform public.enqueue_google_event_change_internal(p_family_event_id,'delete');
end $$;

create or replace function public.complete_google_push_job(p_job_id uuid,p_claim_token uuid,p_completion jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_job public.google_sync_queue%rowtype; v_mapping public.google_event_mappings%rowtype;
begin
  select * into v_job from public.google_sync_queue where id=p_job_id and claim_token=p_claim_token
    and status='processing' and lease_expires_at>clock_timestamp() for update;
  if not found then raise exception 'Google sync job is not currently leased'; end if;
  select * into v_mapping from public.google_event_mappings where id=v_job.google_event_mapping_id for update;
  if coalesce((p_completion->>'finalizeLocalDelete')::boolean,false) then
    delete from public.google_event_mappings where id=v_mapping.id; delete from public.events where id=v_job.family_event_id; return;
  end if;
  if p_completion ? 'reconcileFamilyEvent' then
    update public.events set title=coalesce(p_completion#>>'{reconcileFamilyEvent,title}',title),
      event_date=coalesce((p_completion#>>'{reconcileFamilyEvent,event_date}')::date,event_date),
      start_time=(p_completion#>>'{reconcileFamilyEvent,start_time}')::time,end_time=(p_completion#>>'{reconcileFamilyEvent,end_time}')::time,
      all_day=coalesce((p_completion#>>'{reconcileFamilyEvent,all_day}')::boolean,all_day),
      recurrence=coalesce(p_completion#>>'{reconcileFamilyEvent,recurrence}',recurrence),
      recurrence_end=(p_completion#>>'{reconcileFamilyEvent,recurrence_end}')::date,sync_deleted_at=null where id=v_job.family_event_id;
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
      last_family_updated_at=case when coalesce((p_completion->>'captureReconciledFamilyUpdatedAt')::boolean,false)
        then (select updated_at from public.events where id=v_job.family_event_id)
        else coalesce((p_completion#>>'{mapping,last_family_updated_at}')::timestamptz,last_family_updated_at) end,
      sync_state='synced',safe_error_message=null,updated_at=clock_timestamp() where id=v_mapping.id;
  end if;
  perform public.complete_google_sync_job(p_job_id,p_claim_token);
end $$;

create or replace function public.apply_google_pull_page(p_calendar_id uuid,p_changes jsonb,p_reconciliation jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_change jsonb; v_scan_id uuid:=nullif(p_reconciliation#>>'{scan,scanId}','')::uuid;
  v_mapping public.google_event_mappings%rowtype; v_event public.events%rowtype;
  v_event_id uuid; v_event_updated_at timestamptz; v_rows integer;
begin
  perform 1 from public.google_calendars cal join public.google_connections c on c.id=cal.google_connection_id
    join public.household_members member on member.household_id=c.household_id and member.user_id=c.user_id
    where cal.id=p_calendar_id and cal.updated_at=(p_reconciliation#>>'{run,expectedSyncVersion}')::timestamptz
      and cal.sync_claimed_until>clock_timestamp() and ((v_scan_id is null and cal.sync_token is not distinct from (p_reconciliation#>>'{run,expectedSyncToken}'))
      or (v_scan_id is not null and cal.sync_token is null)) for update of cal;
  if not found then raise exception 'Google pull lease changed'; end if;
  if v_scan_id is not null and not exists(select 1 from public.google_pull_scans s where s.id=v_scan_id
    and s.google_calendar_id=p_calendar_id and s.generation=(p_reconciliation#>>'{scan,generation}')::bigint
    and s.expected_sync_token is not distinct from (p_reconciliation#>>'{run,expectedSyncToken}')
    and s.expected_sync_version=(p_reconciliation#>>'{run,expectedSyncVersion}')::timestamptz)
    then raise exception 'Google reconciliation lease changed'; end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    if v_change->>'kind'='ignore' then continue; end if;
    if v_change->>'kind'='import' then
      perform pg_advisory_xact_lock(hashtextextended(p_calendar_id::text||':'||(v_change->>'googleEventId'),0));
      if exists(select 1 from public.google_event_mappings where google_calendar_id=p_calendar_id and google_event_id=v_change->>'googleEventId') then continue; end if;
      insert into public.events(household_id,person_id,title,event_date,start_time,end_time,all_day,recurrence,recurrence_end,created_by)
      select c.household_id,(v_change#>>'{familyEvent,person_id}')::uuid,v_change#>>'{familyEvent,title}',
        (v_change#>>'{familyEvent,event_date}')::date,(v_change#>>'{familyEvent,start_time}')::time,(v_change#>>'{familyEvent,end_time}')::time,
        (v_change#>>'{familyEvent,all_day}')::boolean,v_change#>>'{familyEvent,recurrence}',(v_change#>>'{familyEvent,recurrence_end}')::date,c.user_id
      from public.google_calendars cal join public.google_connections c on c.id=cal.google_connection_id where cal.id=p_calendar_id
      returning id,updated_at into v_event_id,v_event_updated_at;
      insert into public.google_event_mappings(family_event_id,google_connection_id,google_calendar_id,google_event_id,google_etag,google_updated_at,last_family_updated_at,last_google_updated_at,sync_state,safe_error_message)
      select v_event_id,cal.google_connection_id,cal.id,v_change->>'googleEventId',v_change#>>'{mapping,google_etag}',
        (v_change#>>'{mapping,google_updated_at}')::timestamptz,v_event_updated_at,(v_change#>>'{mapping,last_google_updated_at}')::timestamptz,
        v_change#>>'{mapping,sync_state}',v_change#>>'{mapping,safe_error_message}' from public.google_calendars cal where cal.id=p_calendar_id;
      continue;
    end if;
    select m.* into v_mapping from public.google_event_mappings m where m.google_calendar_id=p_calendar_id
      and m.google_event_id=v_change->>'googleEventId' for update;
    if not found or v_mapping.updated_at is distinct from (v_change#>>'{expected,mappingUpdatedAt}')::timestamptz then raise exception 'Stale Google mapping'; end if;
    select * into v_event from public.events where id=v_mapping.family_event_id for update;
    if not found or v_event.updated_at is distinct from (v_change#>>'{expected,familyUpdatedAt}')::timestamptz then raise exception 'Stale Family event'; end if;
    if v_change->>'kind' in ('update','cancel') then
      update public.events e set title=coalesce(v_change#>>'{familyEventPatch,title}',e.title),
        event_date=coalesce((v_change#>>'{familyEventPatch,event_date}')::date,e.event_date),start_time=(v_change#>>'{familyEventPatch,start_time}')::time,
        end_time=(v_change#>>'{familyEventPatch,end_time}')::time,all_day=coalesce((v_change#>>'{familyEventPatch,all_day}')::boolean,e.all_day),
        recurrence=coalesce(v_change#>>'{familyEventPatch,recurrence}',e.recurrence),recurrence_end=(v_change#>>'{familyEventPatch,recurrence_end}')::date,
        sync_deleted_at=case when v_change->>'kind'='cancel' then clock_timestamp() else null end,updated_at=clock_timestamp()
      where e.id=v_event.id and e.updated_at=v_event.updated_at returning * into v_event;
      get diagnostics v_rows=row_count; if v_rows<>1 then raise exception 'Stale Family event'; end if;
    end if;
    update public.google_event_mappings m set google_etag=v_change#>>'{mapping,google_etag}',google_updated_at=(v_change#>>'{mapping,google_updated_at}')::timestamptz,
      last_google_updated_at=case when v_change#>'{mapping}' ? 'last_google_updated_at' then (v_change#>>'{mapping,last_google_updated_at}')::timestamptz else m.last_google_updated_at end,
      last_family_updated_at=v_event.updated_at,sync_state=v_change#>>'{mapping,sync_state}',safe_error_message=v_change#>>'{mapping,safe_error_message}',updated_at=clock_timestamp()
    where m.id=v_mapping.id and m.updated_at=v_mapping.updated_at returning * into v_mapping;
    get diagnostics v_rows=row_count; if v_rows<>1 then raise exception 'Stale Google mapping'; end if;
    if v_change->>'queuePolicy'='supersede_pending' then update public.google_sync_queue set status='superseded',updated_at=clock_timestamp()
      where family_event_id=v_event.id and status='pending';
    elsif v_change->>'queuePolicy'='ensure_update' then perform public.enqueue_google_event_change_internal(v_event.id,'update'); end if;
    if v_change->>'kind'='cancel' then insert into public.google_pull_cancellation_guards values(p_calendar_id,v_event.id,v_mapping.updated_at,v_event.updated_at)
      on conflict(google_calendar_id,family_event_id) do update set mapping_updated_at=excluded.mapping_updated_at,family_updated_at=excluded.family_updated_at; end if;
  end loop;
  if v_scan_id is not null then update public.google_pull_scans set seen_google_event_ids=array(select distinct unnest(seen_google_event_ids||
    array(select jsonb_array_elements_text(p_reconciliation->'seenGoogleEventIds')))) where id=v_scan_id;
    get diagnostics v_rows=row_count; if v_rows<>1 then raise exception 'Google reconciliation lease changed'; end if;
  end if;
end $$;

revoke all on function public.events_enqueue_google_change() from public,anon,authenticated,service_role;
revoke all on function public.save_google_backed_event(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.request_google_event_delete(uuid) from public,anon,authenticated,service_role;
revoke all on function public.complete_google_push_job(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.apply_google_pull_page(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_google_backed_event(jsonb) to authenticated;
grant execute on function public.request_google_event_delete(uuid) to authenticated;
grant execute on function public.complete_google_push_job(uuid,uuid,jsonb) to service_role;
grant execute on function public.apply_google_pull_page(uuid,jsonb,jsonb) to service_role;
