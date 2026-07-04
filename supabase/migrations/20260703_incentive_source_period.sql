alter table public.incentives
add column if not exists incentive_source text not null default 'personal',
add column if not exists incentive_period text not null default 'season',
add column if not exists target_date date,
add column if not exists start_date date,
add column if not exists end_date date;

update public.incentives
set
  incentive_source = case when incentive_source in ('personal', 'company') then incentive_source else 'personal' end,
  incentive_period = case when incentive_period in ('season', 'month', 'week', 'day', 'custom') then incentive_period else 'season' end;

alter table public.incentives
alter column incentive_source set default 'personal',
alter column incentive_source set not null,
alter column incentive_period set default 'season',
alter column incentive_period set not null;

alter table public.incentives
drop constraint if exists incentives_incentive_source_check;

alter table public.incentives
add constraint incentives_incentive_source_check
check (incentive_source in ('personal', 'company'));

alter table public.incentives
drop constraint if exists incentives_incentive_period_check;

alter table public.incentives
add constraint incentives_incentive_period_check
check (incentive_period in ('season', 'month', 'week', 'day', 'custom'));
