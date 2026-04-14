create extension if not exists pgcrypto;

create table if not exists public.task_checklist (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  owner_name text not null,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  due_date timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists task_checklist_created_at_idx
  on public.task_checklist (created_at desc);

create index if not exists task_checklist_due_date_idx
  on public.task_checklist (due_date asc);

alter table public.task_checklist enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'task_checklist'
      and policyname = 'task_checklist_read_anon'
  ) then
    create policy task_checklist_read_anon
      on public.task_checklist
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

