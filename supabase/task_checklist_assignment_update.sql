alter table public.task_checklist
  add column if not exists creator_user_key text,
  add column if not exists creator_name text;

update public.task_checklist
set creator_user_key = coalesce(creator_user_key, owner_user_key),
    creator_name = coalesce(creator_name, owner_name)
where creator_user_key is null
   or creator_name is null;

alter table public.task_checklist
  alter column creator_user_key set default 'joao';

alter table public.task_checklist
  alter column creator_name set default 'João Pedro';

update public.task_checklist
set creator_user_key = 'joao',
    creator_name = 'João Pedro'
where creator_user_key is null
   or creator_name is null;

alter table public.task_checklist
  alter column creator_user_key set not null;

alter table public.task_checklist
  alter column creator_name set not null;
