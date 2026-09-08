create table if not exists public.google_oauth_generations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  updated_at timestamptz not null default now()
);

insert into public.google_oauth_generations(user_id, generation)
select user_id, max(oauth_generation) from public.google_connections group by user_id
on conflict(user_id) do update set generation=greatest(google_oauth_generations.generation, excluded.generation);

insert into public.google_oauth_generations(user_id, generation)
select user_id, max(connection_generation) from public.google_oauth_flows group by user_id
on conflict(user_id) do update set generation=greatest(google_oauth_generations.generation, excluded.generation);

alter table public.google_oauth_generations enable row level security;
revoke all on table public.google_oauth_generations from public, anon, authenticated;
grant all on table public.google_oauth_generations to service_role;

create or replace function public.begin_google_oauth_flow(
  p_user_id uuid, p_household_id uuid, p_state_hash text,
  p_flow_context text, p_expires_at timestamptz
)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_generation bigint;
begin
  insert into public.google_oauth_generations(user_id, generation, updated_at)
  values(p_user_id, 1, clock_timestamp())
  on conflict(user_id) do update
    set generation=google_oauth_generations.generation + 1,
        updated_at=clock_timestamp()
  returning generation into v_generation;

  update public.google_oauth_flows
  set consumed_at=coalesce(consumed_at,clock_timestamp()), redirect_path='{}'
  where user_id=p_user_id;

  insert into public.google_oauth_flows(
    user_id, household_id, connection_generation, state_hash,
    redirect_path, expires_at
  ) values (
    p_user_id, p_household_id, v_generation, p_state_hash,
    p_flow_context, p_expires_at
  );
  return v_generation;
end $$;

create or replace function public.is_current_google_oauth_generation(
  p_user_id uuid, p_connection_generation bigint
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.google_oauth_generations
    where user_id=p_user_id and generation=p_connection_generation);
$$;

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
  set generation = generation + 1, updated_at=clock_timestamp()
  where user_id=p_user_id and generation=p_connection_generation;
  if not found then return 'invalid_state'; end if;
  return 'ok';
end $$;

create or replace function public.disconnect_google_calendar(
  p_connection_id uuid, p_user_id uuid, p_mode text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_event_ids uuid[]; v_generation bigint;
begin
  if p_mode not in ('keep_local','remove_local') then
    raise exception using errcode='22023', message='google_disconnect_invalid_mode';
  end if;
  if not exists(select 1 from public.google_connections where id=p_connection_id and user_id=p_user_id) then
    return false;
  end if;

  insert into public.google_oauth_generations(user_id,generation,updated_at)
  values(p_user_id,1,clock_timestamp())
  on conflict(user_id) do update set generation=google_oauth_generations.generation+1,updated_at=clock_timestamp()
  returning generation into v_generation;

  perform 1 from public.google_connections
  where id=p_connection_id and user_id=p_user_id for update;
  if not found then return false; end if;

  select coalesce(array_agg(family_event_id),array[]::uuid[]) into v_event_ids
  from public.google_event_mappings where google_connection_id=p_connection_id;
  if p_mode='keep_local' then
    update public.events set sync_deleted_at=null where id=any(v_event_ids);
  end if;
  delete from public.google_sync_queue q using public.google_event_mappings m
    where q.google_event_mapping_id=m.id and m.google_connection_id=p_connection_id;
  delete from public.google_event_mappings where google_connection_id=p_connection_id;
  delete from public.google_calendars where google_connection_id=p_connection_id;
  if p_mode='remove_local' then delete from public.events where id=any(v_event_ids); end if;

  update public.google_oauth_flows
  set consumed_at=coalesce(consumed_at,clock_timestamp()),redirect_path='{}'
  where user_id=p_user_id;
  update public.google_connections set access_token_encrypted=null,refresh_token_encrypted=null,
    token_expires_at=null,connection_state='disconnected',last_error=null,
    disconnected_at=clock_timestamp(),updated_at=clock_timestamp(),oauth_generation=v_generation
  where id=p_connection_id and user_id=p_user_id;
  return true;
end $$;

revoke all on function public.begin_google_oauth_flow(uuid,uuid,text,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.is_current_google_oauth_generation(uuid,bigint) from public,anon,authenticated,service_role;
revoke all on function public.persist_google_oauth_connection(uuid,uuid,uuid,bigint,text,text,bytea,bytea,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.disconnect_google_calendar(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.begin_google_oauth_flow(uuid,uuid,text,text,timestamptz) to service_role;
grant execute on function public.is_current_google_oauth_generation(uuid,bigint) to service_role;
grant execute on function public.persist_google_oauth_connection(uuid,uuid,uuid,bigint,text,text,bytea,bytea,timestamptz) to service_role;
grant execute on function public.disconnect_google_calendar(uuid,uuid,text) to service_role;
