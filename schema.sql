-- FAMILY HUB V2 DATABASE
-- Run this entire file once in Supabase -> SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text unique not null default upper(substr(md5(random()::text), 1, 6)),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index if not exists household_members_user_id_idx on public.household_members(user_id);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  color text not null default '#6f7c8f',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists people_household_id_idx on public.people(household_id);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  title text not null,
  event_date date not null,
  start_time time,
  end_time time,
  recurrence text not null default 'none' check (recurrence in ('none','daily','weekly')),
  recurrence_end date,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists events_household_date_idx on public.events(household_id, event_date);
create index if not exists events_person_id_idx on public.events(person_id);

-- Helper function used by RLS.
create or replace function public.is_household_member(target_household uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members hm
    where hm.household_id = target_household
      and hm.user_id = auth.uid()
  );
$$;

-- New user creates a household and automatically becomes owner.
create or replace function public.create_household(household_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  insert into public.households(name, created_by)
  values (trim(household_name), auth.uid())
  returning id into new_id;

  insert into public.household_members(household_id, user_id, role)
  values (new_id, auth.uid(), 'owner');

  insert into public.people(household_id, name, color, sort_order)
  values
    (new_id, 'Mom', '#5c7c64', 1),
    (new_id, 'Dad', '#58759a', 2),
    (new_id, 'Child 1', '#9a6f9d', 3),
    (new_id, 'Child 2', '#c98652', 4);

  return new_id;
end;
$$;

-- Join an existing household with the six-character code.
create or replace function public.join_household(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select id into target_id
  from public.households
  where upper(join_code) = upper(trim(code));

  if target_id is null then raise exception 'Family code not found'; end if;

  insert into public.household_members(household_id, user_id, role)
  values (target_id, auth.uid(), 'member')
  on conflict do nothing;

  return target_id;
end;
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.people enable row level security;
alter table public.events enable row level security;

revoke all on table public.households, public.household_members, public.people, public.events from anon, authenticated;
grant select on table public.households, public.household_members, public.people, public.events to authenticated;
grant insert, update, delete on table public.people, public.events to authenticated;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;

drop policy if exists households_select on public.households;
create policy households_select on public.households
for select to authenticated
using (public.is_household_member(id));

drop policy if exists members_select on public.household_members;
create policy members_select on public.household_members
for select to authenticated
using (user_id = (select auth.uid()) or public.is_household_member(household_id));

drop policy if exists people_select on public.people;
create policy people_select on public.people
for select to authenticated
using (public.is_household_member(household_id));

drop policy if exists people_insert on public.people;
create policy people_insert on public.people
for insert to authenticated
with check (public.is_household_member(household_id));

drop policy if exists people_update on public.people;
create policy people_update on public.people
for update to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

drop policy if exists people_delete on public.people;
create policy people_delete on public.people
for delete to authenticated
using (public.is_household_member(household_id));

drop policy if exists events_select on public.events;
create policy events_select on public.events
for select to authenticated
using (public.is_household_member(household_id));

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
for insert to authenticated
with check (public.is_household_member(household_id) and created_by = (select auth.uid()));

drop policy if exists events_update on public.events;
create policy events_update on public.events
for update to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

drop policy if exists events_delete on public.events;
create policy events_delete on public.events
for delete to authenticated
using (public.is_household_member(household_id));

-- Realtime
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.people;
