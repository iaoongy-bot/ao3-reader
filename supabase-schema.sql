-- 在 Supabase 控制台的 SQL Editor 中执行一次。
create table if not exists public.ao3_notes (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);

alter table public.ao3_notes enable row level security;

drop policy if exists "Users can read own notes" on public.ao3_notes;
create policy "Users can read own notes" on public.ao3_notes
  for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own notes" on public.ao3_notes;
create policy "Users can insert own notes" on public.ao3_notes
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own notes" on public.ao3_notes;
create policy "Users can update own notes" on public.ao3_notes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists ao3_notes_updated_at_idx
  on public.ao3_notes (user_id, updated_at desc);
