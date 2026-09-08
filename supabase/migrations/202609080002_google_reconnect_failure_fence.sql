-- Fence late 401 bookkeeping from credentials established by a newer OAuth generation.

revoke all on function public.mark_google_connection_reconnect(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.mark_google_connection_reconnect(
  p_connection_id uuid,p_user_id uuid,p_google_account_id text,p_oauth_generation bigint)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.google_connections set connection_state='reconnect_required',updated_at=clock_timestamp()
  where id=p_connection_id and user_id=p_user_id and google_account_id=p_google_account_id
    and oauth_generation=p_oauth_generation and connection_state='active'
    and exists(select 1 from public.household_members hm
      where hm.household_id=google_connections.household_id and hm.user_id=p_user_id);
  return found;
end $$;

create or replace function public.supersede_stale_google_push_job(p_job_id uuid,p_claim_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.google_sync_queue set status='superseded',claim_token=null,lease_expires_at=null,
    error_category=null,safe_error_message=null,updated_at=clock_timestamp()
  where id=p_job_id and claim_token=p_claim_token and status='processing';
end $$;

create or replace function public.cancel_stale_google_pull(p_calendar_id uuid,p_expected_sync_version timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.google_calendars set sync_claimed_until=null
  where id=p_calendar_id and updated_at=p_expected_sync_version;
end $$;

revoke all on function public.mark_google_connection_reconnect(uuid,uuid,text,bigint) from public,anon,authenticated,service_role;
revoke all on function public.supersede_stale_google_push_job(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.cancel_stale_google_pull(uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.mark_google_connection_reconnect(uuid,uuid,text,bigint) to service_role;
grant execute on function public.supersede_stale_google_push_job(uuid,uuid) to service_role;
grant execute on function public.cancel_stale_google_pull(uuid,timestamptz) to service_role;
