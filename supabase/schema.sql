-- Run this file once in the Supabase SQL Editor.
-- Keep the administrator email in sync with js/config.js.

begin;

create table if not exists public.app_state (
  id text primary key check (id = 'primary'),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.app_state enable row level security;
alter table public.app_state force row level security;

create or replace function public.stamp_app_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.version <> old.version + 1 then
    raise exception 'app_state version must increase by exactly one' using errcode = '40001';
  end if;
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists app_state_stamp on public.app_state;
create trigger app_state_stamp
before insert or update on public.app_state
for each row execute function public.stamp_app_state();

revoke all on table public.app_state from anon, authenticated;
grant select on table public.app_state to anon, authenticated;
grant insert (id, document, version) on table public.app_state to authenticated;
grant update (document, version) on table public.app_state to authenticated;

drop policy if exists "Public read-only planner state" on public.app_state;
create policy "Public read-only planner state"
on public.app_state
for select
to anon, authenticated
using (id = 'primary');

drop policy if exists "Administrator creates planner state" on public.app_state;
create policy "Administrator creates planner state"
on public.app_state
for insert
to authenticated
with check (
  id = 'primary'
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'admin@pickleball-planner.app'
);

drop policy if exists "Administrator updates planner state" on public.app_state;
create policy "Administrator updates planner state"
on public.app_state
for update
to authenticated
using (
  id = 'primary'
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'admin@pickleball-planner.app'
)
with check (
  id = 'primary'
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'admin@pickleball-planner.app'
);

-- ---------------------------------------------------------------------------
-- Attendance replies
--
-- Bookings live inside app_state, which only the administrator may write. A
-- player replying "going" must not need that password, so replies live here in
-- their own narrow table that anyone holding the publishable key may write.
-- One row per (booking, player); replying again overwrites the old answer.
--
-- There is no per-player login: whoever picks a name from the roster can set
-- that name's reply. That is the intended trade-off for a shared club planner.
-- ---------------------------------------------------------------------------

create table if not exists public.booking_rsvps (
  booking_id text not null check (char_length(booking_id) between 1 and 64),
  player_id text not null check (char_length(player_id) between 1 and 64),
  response text not null check (response in ('going', 'maybe', 'not_going')),
  updated_at timestamptz not null default now(),
  primary key (booking_id, player_id)
);

alter table public.booking_rsvps enable row level security;
alter table public.booking_rsvps force row level security;

create or replace function public.stamp_booking_rsvp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists booking_rsvps_stamp on public.booking_rsvps;
create trigger booking_rsvps_stamp
before insert or update on public.booking_rsvps
for each row execute function public.stamp_booking_rsvp();

revoke all on table public.booking_rsvps from anon, authenticated;
grant select on table public.booking_rsvps to anon, authenticated;
grant insert (booking_id, player_id, response) on table public.booking_rsvps to anon, authenticated;
-- PostgREST upsert writes every payload column in its ON CONFLICT DO UPDATE,
-- so the key columns need the grant too. They can only be set to values the
-- same role could have inserted as a new row, so this concedes nothing extra.
grant update (booking_id, player_id, response) on table public.booking_rsvps to anon, authenticated;
grant delete on table public.booking_rsvps to authenticated;

drop policy if exists "Public reads attendance" on public.booking_rsvps;
create policy "Public reads attendance"
on public.booking_rsvps
for select
to anon, authenticated
using (true);

drop policy if exists "Public records attendance" on public.booking_rsvps;
create policy "Public records attendance"
on public.booking_rsvps
for insert
to anon, authenticated
with check (true);

drop policy if exists "Public changes attendance" on public.booking_rsvps;
create policy "Public changes attendance"
on public.booking_rsvps
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "Administrator clears attendance" on public.booking_rsvps;
create policy "Administrator clears attendance"
on public.booking_rsvps
for delete
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'admin@pickleball-planner.app');

commit;
