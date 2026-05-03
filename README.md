# Sales Goal Command Center

A free-hosted MVP for calendar-based sales goal planning. The app uses React + Vite, Tailwind CSS, Recharts, lucide-react, Supabase Auth, and Supabase Postgres.

Supabase is the system of record. Goals, date ranges, calendar edits, weekly plans, sales entries, incentives, and settings are saved to Supabase and reloaded after refresh or login.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create a Supabase project on the free plan.

3. In Supabase, open **SQL Editor** and run:

```text
supabase/schema.sql
```

4. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

5. Fill in:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

6. Start the app:

```bash
npm run dev
```

## Supabase Setup Notes

- Enable Email Auth in Supabase Authentication.
- The schema enables Row Level Security.
- Each user can only read/write plans and related records owned by their auth user id.
- The app supports one active plan per user now, with the schema ready for multiple plans later.

## Deploy To Vercel Free/Hobby

1. Push this folder to GitHub.
2. Create a new Vercel project from the repo.
3. Framework preset: **Vite**.
4. Build command:

```bash
npm run build
```

5. Output directory:

```bash
dist
```

6. Add environment variables in Vercel Project Settings:

```bash
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

7. Deploy.

After deploy, open the Vercel URL on phone or laptop, create an account, complete the setup wizard, and your data will save to Supabase.

## Data Model

The Supabase schema includes:

- `users`
- `plans`
- `weeks`
- `goal_periods`
- `calendar_days`
- `sales_entries`
- `time_block_entries`
- `incentives`
- `settings`
- `saved_filters`

## Time Block Migration

If your Supabase project already has the original schema, run this migration in the SQL Editor:

```text
supabase/migrations/20260503_time_blocks.sql
```

It adds:

- `settings.time_blocks_config`
- `time_block_entries`
- RLS policy for time-block rows

Daily totals stay synced to `sales_entries`, while detailed Morning/Afternoon/Evening progress is saved in `time_block_entries`.

## Product Scope

This MVP includes:

- Required login
- First-time setup wizard
- Smart dashboard
- Date-range-aware goal engine
- Editable season dates, tracking dates, and goals
- Calendar scheduler with daily editing
- Morning / Afternoon / Evening time-block tracker
- Sales for Today quick-entry card
- Weekly planner with editable ranges and targets
- Incentives and rewards
- Coach suggestions
- Recharts charts
- Supabase-backed saving
- Vercel deployment path
Trigger Vercel redeploy
