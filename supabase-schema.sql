-- Run this once in Supabase: SQL Editor -> New query -> Run.
-- Each signed-in user can only read and write their own single sync snapshot.

create table if not exists public.trip_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.trip_sync_state enable row level security;

create policy "Users manage their own trip sync state"
on public.trip_sync_state
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
