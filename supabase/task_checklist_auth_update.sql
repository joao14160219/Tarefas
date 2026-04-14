alter table public.task_checklist
  add column if not exists owner_user_key text;

update public.task_checklist
set owner_user_key = case
  when lower(owner_name) like 'jo%pedro' then 'joao'
  when owner_name = 'Rafael Palma' then 'rafael'
  else owner_user_key
end
where owner_user_key is null;

alter table public.task_checklist
  alter column owner_user_key set default 'joao';

update public.task_checklist
set owner_user_key = 'joao'
where owner_user_key is null;

alter table public.task_checklist
  alter column owner_user_key set not null;
