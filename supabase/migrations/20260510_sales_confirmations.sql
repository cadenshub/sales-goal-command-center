create table if not exists public.sales_confirmations (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  date date not null,
  confirmed_sales integer not null default 0,
  cancelled_sales integer not null default 0,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(plan_id, date)
);

drop trigger if exists sales_confirmations_touch_updated_at on public.sales_confirmations;
create trigger sales_confirmations_touch_updated_at
before update on public.sales_confirmations
for each row execute function public.touch_updated_at();

alter table public.sales_confirmations enable row level security;

drop policy if exists "plan owners can manage sales confirmations" on public.sales_confirmations;
create policy "plan owners can manage sales confirmations" on public.sales_confirmations
for all using (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));
