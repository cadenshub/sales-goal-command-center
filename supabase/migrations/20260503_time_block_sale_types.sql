alter table public.time_block_entries
add column if not exists type_breakdown jsonb not null default '{"doors":0,"phone":0}'::jsonb;

update public.time_block_entries
set type_breakdown = jsonb_build_object('doors', actual_sales, 'phone', 0)
where type_breakdown = '{"doors":0,"phone":0}'::jsonb
  and actual_sales > 0;
