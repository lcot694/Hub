-- FAMILY HUB v2 — Supabase setup
-- Run this once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our Family',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (household_id,user_id)
);

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  client_id text not null,
  name text not null,
  color text not null default '#777777',
  created_at timestamptz not null default now(),
  unique(household_id,client_id)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  person_id text not null,
  event_date date not null,
  start_time time,
  end_time time,
  repeat_type text not null default 'none' check (repeat_type in ('none','daily','weekly','monthly')),
  repeat_until date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.family_members enable row level security;
alter table public.events enable row level security;

grant select, insert, update, delete on public.households to authenticated;
grant select, insert, update, delete on public.household_members to authenticated;
grant select, insert, update, delete on public.family_members to authenticated;
grant select, insert, update, delete on public.events to authenticated;

-- A signed-in user can create their own household.
create policy "create own household"
on public.households for insert to authenticated
with check ((select auth.uid()) = created_by);

-- Members may read households they belong to, plus a newly-created household owned by them.
create policy "read household"
on public.households for select to authenticated
using (
  created_by = (select auth.uid())
  or exists (
    select 1 from public.household_members hm
    where hm.household_id = households.id
      and hm.user_id = (select auth.uid())
  )
);

-- Membership policies.
create policy "read own memberships"
on public.household_members for select to authenticated
using (user_id = (select auth.uid()));

create policy "join household created by self"
on public.household_members for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.households h
    where h.id = household_id
      and h.created_by = (select auth.uid())
  )
);

-- Family member data is limited to households the signed-in user belongs to.
create policy "read family members"
on public.family_members for select to authenticated
using (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = family_members.household_id
      and hm.user_id = (select auth.uid())
  )
);
create policy "insert family members"
on public.family_members for insert to authenticated
with check (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = family_members.household_id
      and hm.user_id = (select auth.uid())
  )
);
create policy "update family members"
on public.family_members for update to authenticated
using (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = family_members.household_id
      and hm.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = family_members.household_id
      and hm.user_id = (select auth.uid())
  )
);

-- Events use the same household membership boundary.
create policy "read events"
on public.events for select to authenticated
using (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = events.household_id
      and hm.user_id = (select auth.uid())
  )
);
create policy "insert events"
on public.events for insert to authenticated
with check (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = events.household_id
      and hm.user_id = (select auth.uid())
  )
);
create policy "update events"
on public.events for update to authenticated
using (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = events.household_id
      and hm.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = events.household_id
      and hm.user_id = (select auth.uid())
  )
);
create policy "delete events"
on public.events for delete to authenticated
using (
  exists (
    select 1 from public.household_members hm
    where hm.household_id = events.household_id
      and hm.user_id = (select auth.uid())
  )
);

create index if not exists household_members_user_idx on public.household_members(user_id);
create index if not exists family_members_household_idx on public.family_members(household_id);
create index if not exists events_household_date_idx on public.events(household_id,event_date);
