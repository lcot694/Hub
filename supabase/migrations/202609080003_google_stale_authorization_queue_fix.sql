-- Preserve a stale worker's operation unless newer work makes it redundant.
create or replace function public.supersede_stale_google_push_job(p_job_id uuid,p_claim_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.google_sync_queue
  set status=case when exists(
        select 1 from public.google_sync_queue successor
        where successor.family_event_id=google_sync_queue.family_event_id
          and successor.google_event_mapping_id=google_sync_queue.google_event_mapping_id
          and successor.id<>google_sync_queue.id
          and successor.created_at>google_sync_queue.created_at
          and successor.status in ('pending','processing')
      ) then 'superseded' else 'pending' end,
      next_attempt_at=clock_timestamp(),
      claim_token=null,
      lease_expires_at=null,
      error_category=null,
      safe_error_message=null,
      updated_at=clock_timestamp()
  where id=p_job_id and claim_token=p_claim_token and status='processing';
end $$;

revoke all on function public.supersede_stale_google_push_job(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.supersede_stale_google_push_job(uuid,uuid) to service_role;
