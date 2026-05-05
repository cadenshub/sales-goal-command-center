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

drop trigger if exists time_block_entries_touch_updated_at on public.time_block_entries;
create trigger time_block_entries_touch_updated_at
before update on public.time_block_entries
for each row execute function public.touch_updated_at();

alter table public.time_block_entries enable row level security;

drop policy if exists "plan owners can manage time block entries" on public.time_block_entries;
create policy "plan owners can manage time block entries" on public.time_block_entries
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));
