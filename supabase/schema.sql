create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  tracking_start_date date not null,
  total_goal integer not null default 0,
  starting_sales integer not null default 0,
  default_weekly_goal numeric not null default 0,
  max_sales_per_day numeric not null default 3,
  catchup_strategy text not null default 'balanced',
  include_outside_range_sales boolean not null default false,
  date_range_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  active boolean not null default true
);

create table if not exists public.weeks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  weekly_goal numeric not null default 0,
  custom_goal_enabled boolean not null default false,
  custom_range_enabled boolean not null default false,
  range_label text,
  notes text
);

create table if not exists public.goal_periods (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  title text not null,
  period_type text not null default 'sprint',
  start_date date not null,
  end_date date not null,
  target_sales numeric not null default 0,
  priority text not null default 'normal',
  active boolean not null default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.calendar_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  date date not null,
  day_type text not null default 'normal',
  capacity_weight numeric not null default 1,
  planned_target numeric not null default 0,
  custom_target numeric,
  include_in_calculations boolean not null default true,
  notes text,
  unique(plan_id, date)
);

create table if not exists public.sales_entries (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  date date not null,
  sales_count integer not null default 0,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(plan_id, date)
);

create table if not exists public.incentives (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  title text not null,
  description text,
  incentive_type text not null default 'sales_milestone',
  incentive_source text not null default 'personal' check (incentive_source in ('personal', 'company')),
  incentive_period text not null default 'season' check (incentive_period in ('season', 'month', 'week', 'day', 'custom')),
  target_value numeric not null default 0,
  target_date date,
  start_date date,
  end_date date,
  related_goal_period_id uuid references public.goal_periods(id) on delete set null,
  reward_value numeric,
  status text not null default 'locked',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null unique references public.plans(id) on delete cascade,
  normal_workdays integer[] not null default array[1,2,3,4,5],
  catchup_preference text not null default 'balanced',
  theme_preference text not null default 'system',
  default_week_start_day integer not null default 1,
  time_blocks_config jsonb
);

alter table public.settings
add column if not exists time_blocks_config jsonb;

create table if not exists public.time_block_entries (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  date date not null,
  block_key text not null,
  block_name text not null,
  start_time time not null,
  end_time time not null,
  target_sales numeric not null default 0,
  actual_sales integer not null default 0,
  type_breakdown jsonb not null default '{"doors":0,"phone":0}'::jsonb,
  notes text,
  status text not null default 'not_started',
  capacity_weight numeric not null default 1,
  include_in_calculations boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(plan_id, date, block_key)
);

create table if not exists public.weekly_confirmations (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  submitted_sales integer not null default 0,
  serviced_accounts integer not null default 0,
  active_accounts integer not null default 0,
  confirmed_sales integer not null default 0,
  pending_sales integer not null default 0,
  notes text,
  confirmed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(plan_id, week_start, week_end)
);

create table if not exists public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  title text not null,
  start_date date,
  end_date date,
  filter_type text not null default 'custom',
  created_at timestamptz default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists plans_touch_updated_at on public.plans;
create trigger plans_touch_updated_at
before update on public.plans
for each row execute function public.touch_updated_at();

drop trigger if exists goal_periods_touch_updated_at on public.goal_periods;
create trigger goal_periods_touch_updated_at
before update on public.goal_periods
for each row execute function public.touch_updated_at();

drop trigger if exists sales_entries_touch_updated_at on public.sales_entries;
create trigger sales_entries_touch_updated_at
before update on public.sales_entries
for each row execute function public.touch_updated_at();

drop trigger if exists incentives_touch_updated_at on public.incentives;
create trigger incentives_touch_updated_at
before update on public.incentives
for each row execute function public.touch_updated_at();

drop trigger if exists time_block_entries_touch_updated_at on public.time_block_entries;
create trigger time_block_entries_touch_updated_at
before update on public.time_block_entries
for each row execute function public.touch_updated_at();

drop trigger if exists weekly_confirmations_touch_updated_at on public.weekly_confirmations;
create trigger weekly_confirmations_touch_updated_at
before update on public.weekly_confirmations
for each row execute function public.touch_updated_at();

alter table public.users enable row level security;
alter table public.plans enable row level security;
alter table public.weeks enable row level security;
alter table public.goal_periods enable row level security;
alter table public.calendar_days enable row level security;
alter table public.sales_entries enable row level security;
alter table public.incentives enable row level security;
alter table public.settings enable row level security;
alter table public.saved_filters enable row level security;
alter table public.time_block_entries enable row level security;
alter table public.weekly_confirmations enable row level security;

drop policy if exists "users can read own profile" on public.users;
create policy "users can read own profile" on public.users
for select using (auth.uid() = id);

drop policy if exists "users can upsert own profile" on public.users;
create policy "users can upsert own profile" on public.users
for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "plan owners can manage plans" on public.plans;
create policy "plan owners can manage plans" on public.plans
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "plan owners can manage weeks" on public.weeks;
create policy "plan owners can manage weeks" on public.weeks
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage goal periods" on public.goal_periods;
create policy "plan owners can manage goal periods" on public.goal_periods
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage calendar days" on public.calendar_days;
create policy "plan owners can manage calendar days" on public.calendar_days
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage sales entries" on public.sales_entries;
create policy "plan owners can manage sales entries" on public.sales_entries
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage incentives" on public.incentives;
create policy "plan owners can manage incentives" on public.incentives
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage settings" on public.settings;
create policy "plan owners can manage settings" on public.settings
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage saved filters" on public.saved_filters;
create policy "plan owners can manage saved filters" on public.saved_filters
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage time block entries" on public.time_block_entries;
create policy "plan owners can manage time block entries" on public.time_block_entries
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "plan owners can manage weekly confirmations" on public.weekly_confirmations;
create policy "plan owners can manage weekly confirmations" on public.weekly_confirmations
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));
