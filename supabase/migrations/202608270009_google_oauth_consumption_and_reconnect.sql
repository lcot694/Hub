create or replace function public.consume_google_oauth_flow(
  p_state_hash text, p_consumed_at timestamptz
)
returns table(
  user_id uuid, household_id uuid, connection_generation bigint, redirect_path text
)
language plpgsql security definer set search_path = public as $$
declare
  v_flow public.google_oauth_flows%rowtype;
begin
  select * into v_flow
  from public.google_oauth_flows
  where state_hash=p_state_hash
    and consumed_at is null
    and expires_at > p_consumed_at
  for update;
  if not found then return; end if;

  update public.google_oauth_flows
  set consumed_at=p_consumed_at, redirect_path='{}'
  where id=v_flow.id;

  return query select v_flow.user_id, v_flow.household_id,
    v_flow.connection_generation, v_flow.redirect_path;
end $$;

create or replace function public.persist_google_oauth_connection(
  p_user_id uuid, p_household_id uuid, p_person_id uuid,
  p_connection_generation bigint, p_google_account_id text,
  p_display_email text, p_access_token_encrypted bytea,
  p_refresh_token_encrypted bytea, p_token_expires_at timestamptz
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_latest bigint;
  v_existing public.google_connections%rowtype;
begin
  select generation into v_latest from public.google_oauth_generations
  where user_id=p_user_id for update;
  if not found or v_latest <> p_connection_generation then return 'invalid_state'; end if;

  if not exists(select 1 from public.household_members
    where user_id=p_user_id and household_id=p_household_id) then
    return 'authorization_revoked';
  end if;
  if not exists(select 1 from public.people
    where id=p_person_id and household_id=p_household_id) then
    return 'authorization_revoked';
  end if;

  select * into v_existing from public.google_connections
  where user_id=p_user_id for update;

  if found then
    if v_existing.connection_state = 'disconnected' then
      if p_refresh_token_encrypted is null then return 'refresh_token_required'; end if;
      update public.google_connections set
        household_id=p_household_id,
        person_id=p_person_id,
        google_account_id=p_google_account_id,
        display_email=p_display_email,
        access_token_encrypted=p_access_token_encrypted,
        refresh_token_encrypted=p_refresh_token_encrypted,
        token_expires_at=p_token_expires_at,
        connection_state='active', last_error=null, disconnected_at=null,
        oauth_generation=p_connection_generation + 1, updated_at=clock_timestamp()
      where id=v_existing.id;
    else
      if v_existing.household_id <> p_household_id or v_existing.person_id <> p_person_id then
        return 'context_mismatch';
      end if;
      if v_existing.google_account_id <> p_google_account_id then
        return 'account_switch_requires_disconnect';
      end if;
      if p_refresh_token_encrypted is null and v_existing.refresh_token_encrypted is null then
        return 'refresh_token_required';
      end if;
      update public.google_connections set
        display_email=p_display_email,
        access_token_encrypted=p_access_token_encrypted,
        refresh_token_encrypted=coalesce(p_refresh_token_encrypted, refresh_token_encrypted),
        token_expires_at=p_token_expires_at,
        connection_state='active', last_error=null, disconnected_at=null,
        oauth_generation=p_connection_generation + 1, updated_at=clock_timestamp()
      where id=v_existing.id;
    end if;
  else
    if p_refresh_token_encrypted is null then return 'refresh_token_required'; end if;
    insert into public.google_connections(
      user_id, household_id, person_id, google_account_id, display_email,
      access_token_encrypted, refresh_token_encrypted, token_expires_at,
      connection_state, oauth_generation
    ) values (
      p_user_id, p_household_id, p_person_id, p_google_account_id, p_display_email,
      p_access_token_encrypted, p_refresh_token_encrypted, p_token_expires_at,
      'active', p_connection_generation + 1
    );
  end if;

  update public.google_oauth_generations
  set generation=generation + 1, updated_at=clock_timestamp()
  where user_id=p_user_id and generation=p_connection_generation;
  if not found then return 'invalid_state'; end if;
  return 'ok';
end $$;

revoke all on function public.consume_google_oauth_flow(text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.persist_google_oauth_connection(uuid,uuid,uuid,bigint,text,text,bytea,bytea,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.consume_google_oauth_flow(text,timestamptz) to service_role;
grant execute on function public.persist_google_oauth_connection(uuid,uuid,uuid,bigint,text,text,bytea,bytea,timestamptz) to service_role;
