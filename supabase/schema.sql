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

commit;