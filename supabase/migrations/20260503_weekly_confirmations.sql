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

drop trigger if exists weekly_confirmations_touch_updated_at on public.weekly_confirmations;
create trigger weekly_confirmations_touch_updated_at
before update on public.weekly_confirmations
for each row execute function public.touch_updated_at();

alter table public.weekly_confirmations enable row level security;

drop policy if exists "plan owners can manage weekly confirmations" on public.weekly_confirmations;
create policy "plan owners can manage weekly confirmations" on public.weekly_confirmations
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));
