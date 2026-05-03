import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  Edit3,
  Flame,
  Gift,
  LayoutDashboard,
  LogOut,
  Plus,
  Settings,
  Sparkles,
  Target,
  Trophy,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isSupabaseConfigured } from "./lib/supabase";
import {
  createWorkspace,
  deleteGoalPeriod,
  deleteIncentive,
  deleteWeek,
  ensureProfile,
  getSession,
  loadWorkspace,
  onAuthChange,
  signIn,
  signOut,
  signUp,
  updatePlan,
  upsertCalendarDay,
  upsertGoalPeriod,
  upsertIncentive,
  upsertSalesEntry,
  upsertSettings,
  upsertTimeBlockEntries,
  upsertWeek,
} from "./lib/repository";
import { buildCommandCenter, dayTypes, defaultTimeBlocks, normalizeTimeBlocks } from "./lib/goalEngine";
import {
  addDays,
  datesBetween,
  formatDate,
  formatRange,
  maxISO,
  monthEnd,
  monthStart,
  number,
  parseISO,
  percent,
  todayISO,
  toISO,
  weekdayOptions,
  weekEnd,
  weekStart,
} from "./lib/dates";
import { blankPlan } from "./lib/demoData";

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "calendar", label: "Calendar", icon: Calendar },
  { id: "weekly", label: "Weekly Planner", icon: BarChart3 },
  { id: "goals", label: "Goals", icon: Target },
  { id: "incentives", label: "Incentives", icon: Gift },
  { id: "settings", label: "Settings", icon: Settings },
];

const statusColors = {
  ahead: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  on_track: "bg-blue-100 text-blue-700 ring-blue-200",
  behind: "bg-amber-100 text-amber-800 ring-amber-200",
  critical: "bg-red-100 text-red-700 ring-red-200",
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
};

export default function App() {
  const [session, setSession] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDay, setSelectedDay] = useState(null);
  const [saveState, setSaveState] = useState("Saved");
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return undefined;
    }
    let mounted = true;
    getSession()
      .then(async (activeSession) => {
        if (!mounted) return;
        setSession(activeSession);
        if (activeSession?.user) await bootstrapWorkspace(activeSession.user);
        else setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
    const { data } = onAuthChange(async (nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) await bootstrapWorkspace(nextSession.user);
      else {
        setWorkspace(null);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function bootstrapWorkspace(user) {
    setLoading(true);
    setError("");
    try {
      await ensureProfile(user);
      setWorkspace(await loadWorkspace(user.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const command = useMemo(() => {
    void clockTick;
    return buildCommandCenter(workspace);
  }, [workspace, clockTick]);

  async function saveAndPatch(patcher, saveAction) {
    setWorkspace((current) => patcher(current));
    setSaveState("Saving...");
    try {
      await saveAction();
      setSaveState("Saved");
    } catch (err) {
      setError(err.message);
      setSaveState("Save failed");
      if (session?.user) bootstrapWorkspace(session.user);
    }
  }

  if (!isSupabaseConfigured) return <ConfigRequired />;
  if (!session) return <AuthPage error={error} setError={setError} />;
  if (loading) return <LoadingScreen />;
  if (!workspace) {
    return (
      <SetupWizard
        user={session.user}
        onCreated={(nextWorkspace) => {
          setWorkspace(nextWorkspace);
          setPage("dashboard");
        }}
        setError={setError}
        error={error}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <aside className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white/95 px-2 py-2 backdrop-blur lg:bottom-auto lg:right-auto lg:top-0 lg:h-screen lg:w-72 lg:border-r lg:border-t-0 lg:px-5 lg:py-6">
        <div className="mb-8 hidden items-center gap-3 lg:flex">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-600 text-white shadow-glow">
            <Target size={24} />
          </div>
          <div>
            <div className="text-lg font-black">Sales Goal</div>
            <div className="text-sm font-semibold text-slate-500">Command Center</div>
          </div>
        </div>
        <nav className="grid grid-cols-6 gap-1 lg:grid-cols-1 lg:gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={`flex min-h-14 flex-col items-center justify-center rounded-2xl px-2 text-xs font-bold transition lg:min-h-11 lg:flex-row lg:justify-start lg:gap-3 lg:px-4 lg:text-sm ${
                  page === item.id
                    ? "bg-slate-950 text-white shadow-card"
                    : "text-slate-600 hover:bg-white hover:text-slate-950"
                }`}
              >
                <Icon size={19} />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden pt-8 lg:block">
          <div className="rounded-3xl bg-white p-4 shadow-card">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Sync</div>
            <div className="mt-1 font-black">{saveState}</div>
            <button
              type="button"
              onClick={() => signOut()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="pb-24 lg:ml-72 lg:pb-0">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 px-4 py-4 backdrop-blur xl:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-500">{formatDate(command.today, { weekday: "long" })}</div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950 md:text-3xl">{workspace.plan.name}</h1>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={command.paceStatus.key}>{command.paceStatus.label}</Badge>
              <button
                type="button"
                onClick={() => setPage("goals")}
                className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-card transition hover:-translate-y-0.5"
              >
                Edit plan
              </button>
            </div>
          </div>
          {error && <div className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}
        </header>

        <div className="mx-auto max-w-7xl px-4 py-6 xl:px-8">
          {page === "dashboard" && <Dashboard command={command} setPage={setPage} onSaveDay={saveDay} />}
          {page === "calendar" && (
            <CalendarPage command={command} onSelectDay={setSelectedDay} />
          )}
          {page === "weekly" && <WeeklyPlanner command={command} workspace={workspace} saveWeek={saveWeek} removeWeek={removeWeek} saveDay={saveDay} />}
          {page === "goals" && (
            <GoalsPage
              workspace={workspace}
              command={command}
              savePlan={savePlan}
              saveSettings={saveSettings}
              saveWeek={saveWeek}
              removeWeek={removeWeek}
              saveGoalPeriod={saveGoalPeriod}
              removeGoalPeriod={removeGoalPeriod}
            />
          )}
          {page === "incentives" && (
            <IncentivesPage command={command} workspace={workspace} saveIncentive={saveIncentive} removeIncentive={removeIncentive} />
          )}
          {page === "settings" && <SettingsPage user={session.user} workspace={workspace} saveSettings={saveSettings} />}
        </div>
      </main>

      {selectedDay && (
        <DayEditor
          day={command.dayPlans.find((item) => item.date === selectedDay) || { date: selectedDay }}
          command={command}
          onClose={() => setSelectedDay(null)}
          onSave={async (payload) => {
            await saveDay(selectedDay, payload);
            setSelectedDay(null);
          }}
        />
      )}
    </div>
  );

  async function savePlan(changes) {
    await saveAndPatch(
      (current) => ({ ...current, plan: { ...current.plan, ...changes } }),
      () => updatePlan(workspace.plan.id, changes),
    );
  }

  async function saveSettings(changes) {
    const next = { ...workspace.settings, ...changes, plan_id: workspace.plan.id };
    await saveAndPatch(
      (current) => ({ ...current, settings: next }),
      () => upsertSettings(next),
    );
  }

  async function saveDay(date, payload) {
    const blockEntries = (payload.time_blocks || []).map((block) => ({
      plan_id: workspace.plan.id,
      date,
      block_key: block.key,
      block_name: block.name,
      start_time: block.start_time,
      end_time: block.end_time,
      target_sales: Number(block.target_sales ?? block.target ?? 0),
      actual_sales: Number(block.actual_sales ?? block.actual ?? 0),
      notes: block.notes || "",
      status: block.status || "not_started",
      capacity_weight: Number(block.capacity_weight ?? 1),
      include_in_calculations: block.include_in_calculations !== false,
    }));
    const blockTotal = blockEntries.length
      ? blockEntries.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0)
      : null;
    const day = {
      plan_id: workspace.plan.id,
      date,
      day_type: payload.day_type,
      capacity_weight: Number(payload.capacity_weight),
      planned_target: Number(payload.planned_target || 0),
      custom_target: payload.custom_target === "" || payload.custom_target === null ? null : Number(payload.custom_target),
      include_in_calculations: Boolean(payload.include_in_calculations),
      notes: payload.day_notes || "",
    };
    const entry = {
      plan_id: workspace.plan.id,
      date,
      sales_count: Number(blockTotal ?? payload.sales_count ?? 0),
      notes: payload.sales_notes || "",
    };
    await saveAndPatch(
      (current) => ({
        ...current,
        calendarDays: upsertLocalByDate(current.calendarDays, day),
        salesEntries: upsertLocalByDate(current.salesEntries, entry),
        timeBlockEntries: blockEntries.length
          ? upsertLocalBlocks(current.timeBlockEntries || [], blockEntries)
          : current.timeBlockEntries || [],
      }),
      async () => {
        await Promise.all([
          upsertCalendarDay(day),
          upsertSalesEntry(entry),
          blockEntries.length ? upsertTimeBlockEntries(blockEntries) : Promise.resolve([]),
        ]);
      },
    );
  }

  async function saveWeek(week) {
    const payload = {
      ...(week.id ? { id: week.id } : {}),
      plan_id: workspace.plan.id,
      week_start: week.week_start,
      week_end: week.week_end,
      weekly_goal: Number(week.weekly_goal || 0),
      custom_goal_enabled: Boolean(week.custom_goal_enabled),
      custom_range_enabled: Boolean(week.custom_range_enabled),
      range_label: week.range_label || "",
      notes: week.notes || "",
    };
    await saveAndPatch(
      (current) => ({ ...current, weeks: upsertLocalById(current.weeks, payload) }),
      async () => {
        const saved = await upsertWeek(payload);
        setWorkspace((current) => ({ ...current, weeks: upsertLocalById(current.weeks, saved) }));
      },
    );
  }

  async function removeWeek(id) {
    if (!window.confirm("Delete this weekly override?")) return;
    await saveAndPatch(
      (current) => ({ ...current, weeks: current.weeks.filter((week) => week.id !== id) }),
      () => deleteWeek(id),
    );
  }

  async function saveGoalPeriod(period) {
    const payload = {
      ...(period.id ? { id: period.id } : {}),
      plan_id: workspace.plan.id,
      title: period.title,
      period_type: period.period_type,
      start_date: period.start_date,
      end_date: period.end_date,
      target_sales: Number(period.target_sales || 0),
      priority: period.priority || "normal",
      active: period.active !== false,
      notes: period.notes || "",
    };
    await saveAndPatch(
      (current) => ({ ...current, goalPeriods: upsertLocalById(current.goalPeriods, payload) }),
      async () => {
        const saved = await upsertGoalPeriod(payload);
        setWorkspace((current) => ({ ...current, goalPeriods: upsertLocalById(current.goalPeriods, saved) }));
      },
    );
  }

  async function removeGoalPeriod(id) {
    if (!window.confirm("Delete this custom goal period?")) return;
    await saveAndPatch(
      (current) => ({ ...current, goalPeriods: current.goalPeriods.filter((period) => period.id !== id) }),
      () => deleteGoalPeriod(id),
    );
  }

  async function saveIncentive(incentive) {
    const payload = {
      ...(incentive.id ? { id: incentive.id } : {}),
      plan_id: workspace.plan.id,
      title: incentive.title,
      description: incentive.description || "",
      incentive_type: incentive.incentive_type,
      target_value: Number(incentive.target_value || 0),
      target_date: incentive.target_date || null,
      related_goal_period_id: incentive.related_goal_period_id || null,
      reward_value: incentive.reward_value === "" || incentive.reward_value === null ? null : Number(incentive.reward_value || 0),
      status: incentive.status || "locked",
    };
    await saveAndPatch(
      (current) => ({ ...current, incentives: upsertLocalById(current.incentives, payload) }),
      async () => {
        const saved = await upsertIncentive(payload);
        setWorkspace((current) => ({ ...current, incentives: upsertLocalById(current.incentives, saved) }));
      },
    );
  }

  async function removeIncentive(id) {
    if (!window.confirm("Delete this incentive?")) return;
    await saveAndPatch(
      (current) => ({ ...current, incentives: current.incentives.filter((item) => item.id !== id) }),
      () => deleteIncentive(id),
    );
  }
}

function ConfigRequired() {
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="max-w-3xl rounded-[2rem] bg-white p-8 shadow-card">
        <div className="mb-5 inline-flex rounded-2xl bg-indigo-100 p-3 text-indigo-700">
          <Settings />
        </div>
        <h1 className="text-3xl font-black">Connect Supabase to run Sales Goal Command Center</h1>
        <p className="mt-3 text-slate-600">
          This MVP is built for hosted saving through Supabase Auth and Database. Add your free Supabase URL and anon
          key to a local <code className="font-bold">.env</code> file, then run the SQL schema.
        </p>
        <div className="mt-6 rounded-2xl bg-slate-950 p-5 text-sm font-semibold text-white">
          <div>VITE_SUPABASE_URL=https://your-project.supabase.co</div>
          <div>VITE_SUPABASE_ANON_KEY=your-public-anon-key</div>
        </div>
        <p className="mt-5 text-sm font-semibold text-slate-500">
          See README.md for Supabase and Vercel setup steps.
        </p>
      </div>
    </div>
  );
}

function AuthPage({ error, setError }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signin") await signIn(email, password);
      else await signUp(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-[2rem] bg-white shadow-glow lg:grid-cols-[1.1fr_0.9fr]">
        <div className="gradient-hero p-8 text-white lg:p-12">
          <div className="inline-flex rounded-2xl bg-white/15 p-3">
            <Target />
          </div>
          <h1 className="mt-8 text-4xl font-black tracking-tight md:text-5xl">Sales Goal Command Center</h1>
          <p className="mt-5 max-w-xl text-lg text-white/78">
            Calendar-based sales planning, catch-up math, rewards, and weekly execution. Built to save online and work
            across your phone and laptop.
          </p>
          <div className="mt-8 grid gap-3 text-sm font-bold text-white/85">
            <div className="flex items-center gap-2"><CheckCircle2 size={18} /> Supabase Auth required</div>
            <div className="flex items-center gap-2"><CheckCircle2 size={18} /> Hosted database saving</div>
            <div className="flex items-center gap-2"><CheckCircle2 size={18} /> Deployable to Vercel Hobby</div>
          </div>
        </div>
        <form onSubmit={submit} className="p-8 lg:p-12">
          <h2 className="text-2xl font-black">{mode === "signin" ? "Welcome back" : "Create your account"}</h2>
          <p className="mt-2 text-sm font-semibold text-slate-500">
            Sign in to load your saved plan from Supabase.
          </p>
          {error && <div className="mt-4 rounded-2xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>}
          <div className="mt-6 grid gap-4">
            <Field label="Email" value={email} onChange={setEmail} type="email" required />
            <Field label="Password" value={password} onChange={setPassword} type="password" required />
          </div>
          <button className="mt-6 w-full rounded-2xl bg-slate-950 px-5 py-4 font-black text-white" disabled={busy}>
            {busy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="mt-4 w-full rounded-2xl border border-slate-200 px-5 py-3 font-bold text-slate-600"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

function SetupWizard({ user, onCreated, setError, error }) {
  const seed = blankPlan();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({
    ...seed,
    weeks: [],
    goalPeriods: [],
    calendarDays: [],
    incentives: [
      { title: "Dinner reward", description: "25 sales milestone", incentive_type: "sales_milestone", target_value: 25, reward_value: 100, status: "locked" },
      { title: "Season prize", description: "Hit the full season goal", incentive_type: "season_goal", target_value: 100, reward_value: 500, status: "locked" },
    ],
  });
  const [busy, setBusy] = useState(false);
  const steps = ["Plan", "Weeks", "Schedule", "Catch-up", "Rewards"];

  function updatePlanField(key, value) {
    setDraft((current) => ({ ...current, plan: { ...current.plan, [key]: value } }));
  }

  function updateSettingsField(key, value) {
    setDraft((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
  }

  async function finish() {
    setBusy(true);
    setError("");
    try {
      const workspace = await createWorkspace(user.id, {
        ...draft,
        plan: {
          ...draft.plan,
          total_goal: Number(draft.plan.total_goal || 0),
          starting_sales: Number(draft.plan.starting_sales || 0),
          default_weekly_goal: Number(draft.plan.default_weekly_goal || 0),
          max_sales_per_day: Number(draft.plan.max_sales_per_day || 0),
        },
      });
      onCreated(workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 py-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-black uppercase tracking-wide text-indigo-600">First-time setup</div>
          <h1 className="text-4xl font-black">Build your command center</h1>
        </div>
        <div className="flex gap-2">
          {steps.map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => setStep(index)}
              className={`h-3 w-10 rounded-full ${index <= step ? "bg-indigo-600" : "bg-slate-200"}`}
              aria-label={label}
            />
          ))}
        </div>
      </div>
      {error && <div className="mb-5 rounded-2xl bg-red-50 p-4 font-bold text-red-700">{error}</div>}
      <div className="glass-card rounded-[2rem] p-5 md:p-8">
        {step === 0 && (
          <Section title="Basic plan info" icon={Target}>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Plan name" value={draft.plan.name} onChange={(v) => updatePlanField("name", v)} />
              <Field label="Season start" type="date" value={draft.plan.start_date} onChange={(v) => updatePlanField("start_date", v)} />
              <Field label="Season end" type="date" value={draft.plan.end_date} onChange={(v) => updatePlanField("end_date", v)} />
              <Field label="Tracking start" type="date" value={draft.plan.tracking_start_date} onChange={(v) => updatePlanField("tracking_start_date", v)} />
              <Field label="Season sales goal" type="number" value={draft.plan.total_goal} onChange={(v) => updatePlanField("total_goal", v)} />
              <Field label="Starting sales count" type="number" value={draft.plan.starting_sales} onChange={(v) => updatePlanField("starting_sales", v)} />
            </div>
            <Toggle
              label="Count sales outside the active date range"
              checked={draft.plan.include_outside_range_sales}
              onChange={(v) => updatePlanField("include_outside_range_sales", v)}
            />
          </Section>
        )}
        {step === 1 && (
          <Section title="Weekly goals and custom ranges" icon={BarChart3}>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Default weekly goal" type="number" value={draft.plan.default_weekly_goal} onChange={(v) => updatePlanField("default_weekly_goal", v)} />
              <button
                type="button"
                onClick={() => {
                  const weeks = autoBuildWeeks(draft.plan);
                  setDraft((current) => ({ ...current, weeks }));
                }}
                className="self-end rounded-2xl bg-indigo-600 px-4 py-3 font-black text-white"
              >
                Auto-calculate weeks
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    weeks: [
                      ...current.weeks,
                      {
                        week_start: current.plan.start_date,
                        week_end: toISO(addDays(parseISO(current.plan.start_date), 6)),
                        weekly_goal: current.plan.default_weekly_goal,
                        custom_goal_enabled: true,
                        custom_range_enabled: true,
                        range_label: "Custom push week",
                        notes: "",
                      },
                    ],
                  }))
                }
                className="self-end rounded-2xl border border-slate-200 px-4 py-3 font-black"
              >
                Add custom week
              </button>
            </div>
            <EditableList
              items={draft.weeks}
              empty="No weekly overrides yet."
              render={(week, index) => (
                <WeekMiniEditor
                  week={week}
                  onChange={(next) =>
                    setDraft((current) => ({
                      ...current,
                      weeks: current.weeks.map((item, i) => (i === index ? next : item)),
                    }))
                  }
                  onDelete={() => setDraft((current) => ({ ...current, weeks: current.weeks.filter((_, i) => i !== index) }))}
                />
              )}
            />
          </Section>
        )}
        {step === 2 && (
          <Section title="Work schedule and capacity" icon={Calendar}>
            <WeekdayPicker
              value={draft.settings.normal_workdays}
              onChange={(normal_workdays) => updateSettingsField("normal_workdays", normal_workdays)}
            />
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <Field label="Week starts on" type="select" value={draft.settings.default_week_start_day} onChange={(v) => updateSettingsField("default_week_start_day", Number(v))} options={weekdayOptions} />
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    calendarDays: [
                      ...current.calendarDays,
                      {
                        date: todayISO(),
                        day_type: "off",
                        capacity_weight: 0,
                        planned_target: 0,
                        custom_target: null,
                        include_in_calculations: false,
                        notes: "Planned day off",
                      },
                    ],
                  }))
                }
                className="self-end rounded-2xl border border-slate-200 px-4 py-3 font-black"
              >
                Add schedule override
              </button>
            </div>
            <EditableList
              items={draft.calendarDays}
              empty="Add planned off days, half days, or big push days."
              render={(day, index) => (
                <DayMiniEditor
                  day={day}
                  onChange={(next) =>
                    setDraft((current) => ({
                      ...current,
                      calendarDays: current.calendarDays.map((item, i) => (i === index ? next : item)),
                    }))
                  }
                  onDelete={() => setDraft((current) => ({ ...current, calendarDays: current.calendarDays.filter((_, i) => i !== index) }))}
                />
              )}
            />
          </Section>
        )}
        {step === 3 && (
          <Section title="Catch-up preferences and sprints" icon={TrendingUp}>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Max realistic sales/day" type="number" value={draft.plan.max_sales_per_day} onChange={(v) => updatePlanField("max_sales_per_day", v)} />
              <Field
                label="Catch-up strategy"
                type="select"
                value={draft.plan.catchup_strategy}
                onChange={(v) => updatePlanField("catchup_strategy", v)}
                options={[
                  { value: "balanced", label: "Spread evenly" },
                  { value: "front_loaded", label: "Prioritize sooner days" },
                  { value: "weekly_first", label: "Weekly goal matters most" },
                  { value: "season_first", label: "Season goal matters most" },
                ]}
              />
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    goalPeriods: [
                      ...current.goalPeriods,
                      {
                        title: "Two-week sprint",
                        period_type: "sprint",
                        start_date: todayISO(),
                        end_date: toISO(addDays(new Date(), 13)),
                        target_sales: 20,
                        priority: "high",
                        active: true,
                        notes: "",
                      },
                    ],
                  }))
                }
                className="self-end rounded-2xl border border-slate-200 px-4 py-3 font-black"
              >
                Add sprint goal
              </button>
            </div>
            <EditableList
              items={draft.goalPeriods}
              empty="No sprint or custom goal periods yet."
              render={(period, index) => (
                <GoalPeriodMiniEditor
                  period={period}
                  onChange={(next) =>
                    setDraft((current) => ({
                      ...current,
                      goalPeriods: current.goalPeriods.map((item, i) => (i === index ? next : item)),
                    }))
                  }
                  onDelete={() => setDraft((current) => ({ ...current, goalPeriods: current.goalPeriods.filter((_, i) => i !== index) }))}
                />
              )}
            />
          </Section>
        )}
        {step === 4 && (
          <Section title="Incentives and rewards" icon={Gift}>
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  incentives: [
                    ...current.incentives,
                    {
                      title: "New reward",
                      description: "",
                      incentive_type: "sales_milestone",
                      target_value: 25,
                      reward_value: "",
                      status: "locked",
                    },
                  ],
                }))
              }
              className="rounded-2xl bg-purple-600 px-4 py-3 font-black text-white"
            >
              Add reward
            </button>
            <EditableList
              items={draft.incentives}
              empty="Add milestone rewards to make the plan feel alive."
              render={(incentive, index) => (
                <IncentiveMiniEditor
                  incentive={incentive}
                  onChange={(next) =>
                    setDraft((current) => ({
                      ...current,
                      incentives: current.incentives.map((item, i) => (i === index ? next : item)),
                    }))
                  }
                  onDelete={() => setDraft((current) => ({ ...current, incentives: current.incentives.filter((_, i) => i !== index) }))}
                />
              )}
            />
          </Section>
        )}
      </div>
      <div className="mt-6 flex justify-between">
        <button
          type="button"
          onClick={() => setStep(Math.max(0, step - 1))}
          className="rounded-2xl border border-slate-200 px-5 py-3 font-black"
        >
          Back
        </button>
        {step < steps.length - 1 ? (
          <button type="button" onClick={() => setStep(step + 1)} className="rounded-2xl bg-slate-950 px-5 py-3 font-black text-white">
            Continue
          </button>
        ) : (
          <button type="button" onClick={finish} className="rounded-2xl bg-emerald-600 px-5 py-3 font-black text-white" disabled={busy}>
            {busy ? "Saving..." : "Launch dashboard"}
          </button>
        )}
      </div>
    </div>
  );
}

function Dashboard({ command, setPage, onSaveDay }) {
  const completion = command.plan.total_goal > 0 ? (command.completed / command.plan.total_goal) * 100 : 0;
  return (
    <div className="grid gap-5">
      <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <TodaySalesCard command={command} onSaveDay={onSaveDay} />
        <section className="gradient-hero celebrate overflow-hidden rounded-[2rem] p-6 text-white shadow-glow md:p-8">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-black">
            <Sparkles size={16} /> Command brief
          </div>
          <h2 className="text-3xl font-black tracking-tight md:text-4xl">{heroMessage(command)}</h2>
          <p className="mt-4 text-white/75">
            Need <strong className="text-white">{number(command.salesNeededToday, 1)}</strong> today,{" "}
            <strong className="text-white">{number(command.requiredThisWeek, 1)}</strong> per remaining workday this week, and{" "}
            <strong className="text-white">{number(command.requiredPerWorkday, 1)}</strong> per workday for the season.
          </p>
          <div className="mt-6 rounded-3xl bg-white/12 p-5">
            <div className="text-sm font-bold text-white/70">Season completion</div>
            <div className="mt-2 text-5xl font-black">{percent(completion)}</div>
            <Progress value={completion} tone="white" />
          </div>
        </section>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Target} label="Sales completed" value={number(command.completed)} sub={`${number(command.remaining)} remaining of ${number(command.plan.total_goal)}`} />
        <Stat icon={Clock} label="Days left" value={number(command.daysRemaining)} sub={`${number(command.remainingWorkCapacity, 1)} weighted workdays`} />
        <Stat icon={TrendingUp} label="Projected finish" value={number(command.projectedFinish, 1)} sub={`${number(command.projectedFinish - command.plan.total_goal, 1)} vs goal`} />
        <Stat icon={Trophy} label="Next reward" value={command.nextIncentive?.title || "No reward"} sub={command.nextIncentive ? `${percent(command.nextIncentive.progress)} unlocked` : "Add one on Incentives"} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Card title="Actual sales vs goal pace" icon={BarChart3}>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={command.charts.goalLine}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="goal" stroke="#6366f1" strokeWidth={3} dot={false} />
                <Line type="monotone" dataKey="actual" stroke="#10b981" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <CoachCard command={command} />
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <Card title="Time-block performance" icon={Clock}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={command.charts.timeBlocks}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="block" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="target" fill="#a78bfa" radius={[8, 8, 0, 0]} />
                <Bar dataKey="actual" fill="#14b8a6" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Projection" icon={TrendingUp}>
          <Metric label="Current pace" value={`${number(command.avgPerWorkedDay, 2)} / worked day`} />
          <Metric label="Projected finish" value={number(command.projectedFinish, 1)} />
          <Metric label="Goal" value={number(command.plan.total_goal)} />
          <Metric label="Difference" value={number(command.projectedFinish - command.plan.total_goal, 1)} />
          <div className="mt-4 rounded-3xl bg-slate-50 p-4 text-sm font-bold text-slate-600">
            {command.projectedFinish >= command.plan.total_goal
              ? "You are trending toward the goal. Keep the daily floor intact."
              : "Projection is short. Use the Today card to create momentum early."}
          </div>
        </Card>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <Card title="Current week" icon={Calendar}>
          <Metric label="Week range" value={formatRange(command.currentWeek.week_start, command.currentWeek.week_end)} />
          <Metric label="Goal" value={number(command.currentWeek.weekly_goal)} />
          <Metric label="Actual" value={number(command.currentWeekActual)} />
          <Metric label="Still needed" value={number(command.currentWeekRemaining, 1)} />
          <Metric label="Required/day" value={number(command.requiredThisWeek, 1)} />
          <Progress value={(command.currentWeekActual / Math.max(1, command.currentWeek.weekly_goal)) * 100} />
        </Card>
        <Card title="Forecast" icon={TrendingUp}>
          <Metric label="Average / worked day" value={number(command.avgPerWorkedDay, 2)} />
          <Metric label="Best day" value={command.bestDay ? `${formatDate(command.bestDay)} (${number(command.entriesByDate[command.bestDay]?.sales_count)})` : "None yet"} />
          <Metric label="Worst day" value={command.worstDay ? `${formatDate(command.worstDay)} (${number(command.entriesByDate[command.worstDay]?.sales_count)})` : "None yet"} />
          <Metric label="Current streak" value={`${number(command.currentStreak)} days`} />
          <Metric label="Zero-sale days" value={number(command.zeroSaleDays)} />
        </Card>
        <Card title="Next incentive" icon={Gift}>
          {command.nextIncentive ? (
            <>
              <div className="text-2xl font-black">{command.nextIncentive.title}</div>
              <p className="mt-2 text-sm font-semibold text-slate-500">{command.nextIncentive.description}</p>
              <Progress value={command.nextIncentive.progress} tone="purple" />
              <Metric label="Progress" value={`${number(command.nextIncentive.current, 1)} / ${number(command.nextIncentive.target, 1)}`} />
            </>
          ) : (
            <button type="button" onClick={() => setPage("incentives")} className="rounded-2xl bg-purple-600 px-4 py-3 font-black text-white">
              Add incentives
            </button>
          )}
        </Card>
      </section>
    </div>
  );
}

function TodaySalesCard({ command, onSaveDay }) {
  const today = command.todayPlan;
  const [notes, setNotes] = useState(today?.notes || "");
  const [manualSales, setManualSales] = useState(today?.actual || 0);
  const [blockDrafts, setBlockDrafts] = useState(() => blockDraftsFromDay(today));
  const currentBlock = blockDrafts.find((block) => block.isCurrent) || today?.timeBlocks.currentBlock;

  useEffect(() => {
    setNotes(today?.notes || "");
    setManualSales(today?.actual || 0);
    setBlockDrafts(blockDraftsFromDay(today));
  }, [today]);

  if (!today) return null;

  const totalActual = blockDrafts.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0);
  const totalTarget = today.plannedTarget;
  const remaining = Math.max(0, totalTarget - totalActual);
  const activeBlock = currentBlock || blockDrafts.find((block) => block.active && !block.is_break);

  function quickAdd(amount, key = activeBlock?.key) {
    if (!key) return;
    setManualSales((value) => Number(value || 0) + amount);
    setBlockDrafts((current) =>
      current.map((block) =>
        block.key === key
          ? { ...block, actual_sales: Number(block.actual_sales || 0) + amount, status: "current" }
          : block,
      ),
    );
  }

  async function save() {
    const currentTotal = blockDrafts.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0);
    const diff = Number(manualSales || 0) - currentTotal;
    const blocksToSave =
      diff !== 0 && activeBlock
        ? blockDrafts.map((block) =>
            block.key === activeBlock.key
              ? { ...block, actual_sales: Math.max(0, Number(block.actual_sales || 0) + diff) }
              : block,
          )
        : blockDrafts;
    await onSaveDay(today.date, {
      sales_count: manualSales,
      sales_notes: notes,
      day_type: today.dayType,
      capacity_weight: today.capacity,
      planned_target: today.plannedTarget,
      custom_target: today.customTarget ?? "",
      include_in_calculations: today.include,
      day_notes: today.notes,
      time_blocks: blocksToSave.map((block) => ({
        ...block,
        target_sales: block.target,
        actual_sales: Number(block.actual_sales || 0),
      })),
    });
  }

  return (
    <section className="glass-card rounded-[2rem] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm font-black uppercase tracking-wide text-indigo-600">Sales for today</div>
          <h2 className="mt-1 text-3xl font-black tracking-tight">{formatDate(today.date, { weekday: "long" })}</h2>
          <p className="mt-2 text-sm font-bold text-slate-500">
            {today.dayType === "off"
              ? "Today is marked off. You can still log bonus sales."
              : today.timeBlocks.message}
          </p>
        </div>
        <Badge tone={statusTone(today.status)}>{today.status}</Badge>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <MiniMetric label="Goal" value={number(totalTarget, 1)} />
        <MiniMetric label="Done" value={number(totalActual)} />
        <MiniMetric label="Left" value={number(remaining, 1)} />
      </div>

      <div className="mt-5 rounded-3xl bg-slate-950 p-4 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-black uppercase tracking-wide text-white/55">Current block</div>
            <div className="text-2xl font-black">{activeBlock?.name || "Day review"}</div>
          </div>
          <div className="text-right text-sm font-bold text-white/75">
            {activeBlock?.minutesLeft ? `${Math.floor(activeBlock.minutesLeft / 60)}h ${activeBlock.minutesLeft % 60}m left` : "Final results"}
            <div className="text-white">{number(activeBlock?.remaining || remaining, 1)} needed</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[1, 2, 5].map((amount) => (
            <button
              key={amount}
              type="button"
              onClick={() => quickAdd(amount)}
              className="rounded-2xl bg-white px-4 py-3 font-black text-slate-950 transition hover:-translate-y-0.5"
            >
              +{amount}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        {blockDrafts.map((block) => (
          <div
            key={block.key}
            className={`rounded-3xl border p-4 ${
              block.isCurrent ? "border-indigo-300 bg-indigo-50" : block.is_break ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-black">{block.name}</div>
                <div className="text-xs font-bold text-slate-500">{block.start_time} - {block.end_time}</div>
              </div>
              <Badge tone={statusTone(block.status)}>{block.status}</Badge>
            </div>
            <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
              <div>
                <Progress value={(Number(block.actual_sales || 0) / Math.max(1, Number(block.target || 0))) * 100} tone={block.is_break ? "slate" : "purple"} />
                <div className="mt-2 text-sm font-bold text-slate-500">
                  {number(block.actual_sales || 0)} / {number(block.target || 0, 1)} sales
                </div>
              </div>
              {!block.is_break && (
                <div className="flex gap-1">
                  {[1, 2].map((amount) => (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => quickAdd(amount, block.key)}
                      className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-black"
                    >
                      +{amount}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-[0.4fr_1fr]">
        <Field label="Manual total" type="number" value={manualSales} onChange={setManualSales} />
        <Field label="Notes" value={notes} onChange={setNotes} />
      </div>
      <button type="button" onClick={save} className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-4 font-black text-white shadow-card transition hover:-translate-y-0.5">
        Save today
      </button>
    </section>
  );
}

function CalendarPage({ command, onSelectDay }) {
  const [mode, setMode] = useState("month");
  const [anchor, setAnchor] = useState(command.today);
  const [filter, setFilter] = useState("all");
  const [customStart, setCustomStart] = useState(command.plan.start_date);
  const [customEnd, setCustomEnd] = useState(command.plan.end_date);
  const range = getCalendarRange(mode, anchor, customStart, customEnd, command);
  const days = command.dayPlans.filter((day) => day.date >= range.start && day.date <= range.end).filter((day) => applyDayFilter(day, filter));

  return (
    <div className="grid gap-5">
      <Card title="Calendar scheduler" icon={Calendar}>
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap gap-2">
            {["week", "month", "custom", "season"].map((item) => (
              <button key={item} type="button" onClick={() => setMode(item)} className={`rounded-2xl px-4 py-2 text-sm font-black capitalize ${mode === item ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-600"}`}>
                {item}
              </button>
            ))}
            <button type="button" onClick={() => setAnchor(command.today)} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black">Today</button>
            <button type="button" onClick={() => setAnchor(toISO(addDays(parseISO(anchor), mode === "week" ? -7 : -30)))} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black">Previous</button>
            <button type="button" onClick={() => setAnchor(toISO(addDays(parseISO(anchor), mode === "week" ? 7 : 30)))} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black">Next</button>
          </div>
          <Field
            label="Filter"
            type="select"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All days" },
              { value: "active", label: "Active selling days" },
              { value: "off", label: "Off days" },
              { value: "missed", label: "Missed days" },
              { value: "priority", label: "High-priority days" },
            ]}
          />
        </div>
        {mode === "custom" && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="Custom start" type="date" value={customStart} onChange={setCustomStart} />
            <Field label="Custom end" type="date" value={customEnd} onChange={setCustomEnd} />
          </div>
        )}
      </Card>
      <div className={`grid gap-3 ${mode === "month" || mode === "week" ? "md:grid-cols-7" : "sm:grid-cols-2 xl:grid-cols-4"}`}>
        {(mode === "month" || mode === "week") &&
          weekdayOptions.map((day) => (
            <div key={day.value} className="hidden rounded-2xl bg-white/70 px-3 py-2 text-center text-xs font-black uppercase tracking-wide text-slate-400 md:block">
              {day.label}
            </div>
          ))}
        {days.map((day) => (
          <button
            key={day.date}
            type="button"
            onClick={() => onSelectDay(day.date)}
            className={`min-h-44 rounded-3xl border p-4 text-left shadow-card transition hover:-translate-y-1 hover:shadow-glow ${
              day.dayType === "off"
                ? "border-slate-200 bg-slate-100"
                : day.isToday
                  ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-200"
                  : day.isPast
                    ? "border-slate-200 bg-white"
                    : "border-slate-200 bg-white/80"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-black text-slate-500">{formatDate(day.date, { weekday: "short", year: undefined })}</div>
                <div className="mt-1 text-xl font-black">{parseISO(day.date).getDate()}</div>
              </div>
              <Badge tone={statusTone(day.status)}>{day.status}</Badge>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <MiniMetric label="Target" value={number(day.plannedTarget, 1)} />
              <MiniMetric label="Actual" value={number(day.actual)} />
              <MiniMetric label="Diff" value={number(day.delta, 1)} />
            </div>
            <div className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm font-bold text-slate-600">
              {dayTypes[day.dayType]?.label || "Custom"} · {number(day.capacity, 1)}x capacity
            </div>
            {day.isToday && (
              <div className="mt-3 flex gap-1">
                {day.timeBlocks.blocks.filter((block) => block.active && !block.is_break).map((block) => (
                  <span
                    key={block.key}
                    className={`h-2 flex-1 rounded-full ${block.actual >= block.target ? "bg-emerald-400" : block.isCurrent ? "bg-indigo-500" : "bg-slate-200"}`}
                    title={`${block.name}: ${number(block.actual)} / ${number(block.target, 1)}`}
                  />
                ))}
              </div>
            )}
            {day.notes && <p className="mt-3 line-clamp-2 text-sm font-semibold text-slate-500">{day.notes}</p>}
          </button>
        ))}
      </div>
    </div>
  );
}

function WeeklyPlanner({ command, saveWeek, removeWeek, saveDay }) {
  return (
    <div className="grid gap-5">
      <Card title="Weekly planner" icon={BarChart3}>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={command.charts.weekly}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="goal" fill="#6366f1" radius={[8, 8, 0, 0]} />
              <Bar dataKey="actual" fill="#10b981" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        {command.weeks.map((week) => (
          <WeekCard key={`${week.week_start}-${week.week_end}-${week.id || ""}`} week={week} command={command} saveWeek={saveWeek} removeWeek={removeWeek} saveDay={saveDay} />
        ))}
      </div>
    </div>
  );
}

function GoalsPage({ workspace, command, savePlan, saveSettings, saveWeek, removeWeek, saveGoalPeriod, removeGoalPeriod }) {
  const [draft, setDraft] = useState(workspace.plan);
  const preview = buildDatePreview(command, draft);

  useEffect(() => setDraft(workspace.plan), [workspace.plan]);

  return (
    <div className="grid gap-5">
      <Card title="Plan and date ranges" icon={Target}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Plan name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
          <Field label="Season start" type="date" value={draft.start_date} onChange={(v) => setDraft({ ...draft, start_date: v })} />
          <Field label="Season end" type="date" value={draft.end_date} onChange={(v) => setDraft({ ...draft, end_date: v })} />
          <Field label="Tracking start" type="date" value={draft.tracking_start_date} onChange={(v) => setDraft({ ...draft, tracking_start_date: v })} />
          <Field label="Season goal" type="number" value={draft.total_goal} onChange={(v) => setDraft({ ...draft, total_goal: v })} />
          <Field label="Starting sales" type="number" value={draft.starting_sales} onChange={(v) => setDraft({ ...draft, starting_sales: v })} />
          <Field label="Default weekly goal" type="number" value={draft.default_weekly_goal} onChange={(v) => setDraft({ ...draft, default_weekly_goal: v })} />
          <Field label="Max realistic sales/day" type="number" value={draft.max_sales_per_day} onChange={(v) => setDraft({ ...draft, max_sales_per_day: v })} />
          <Field
            label="Catch-up strategy"
            type="select"
            value={draft.catchup_strategy}
            onChange={(v) => setDraft({ ...draft, catchup_strategy: v })}
            options={[
              { value: "balanced", label: "Spread evenly" },
              { value: "front_loaded", label: "Prioritize certain days" },
              { value: "weekly_first", label: "Weekly goals matter more" },
              { value: "season_first", label: "Season goal matters more" },
            ]}
          />
        </div>
        <Toggle label="Include outside-range sales in calculations" checked={draft.include_outside_range_sales} onChange={(v) => setDraft({ ...draft, include_outside_range_sales: v })} />
        <div className={`mt-5 rounded-3xl p-4 ${preview.warning ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}`}>
          <div className="flex items-center gap-2 font-black">
            {preview.warning ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />} Preview
          </div>
          <p className="mt-1 text-sm font-semibold">{preview.message}</p>
        </div>
        <button type="button" onClick={() => savePlan(normalizePlanDraft(draft))} className="mt-5 rounded-2xl bg-slate-950 px-5 py-3 font-black text-white">
          Apply plan changes
        </button>
        {command.outsideRangeEntries.length > 0 && (
          <div className="mt-4 rounded-3xl bg-red-50 p-4 text-sm font-bold text-red-700">
            {command.outsideRangeEntries.length} sales entries fall outside the active date range. They are kept saved and can be included or excluded above.
          </div>
        )}
      </Card>

      <Card title="Workday assumptions" icon={Calendar}>
        <WeekdayPicker value={workspace.settings.normal_workdays} onChange={(normal_workdays) => saveSettings({ normal_workdays })} />
        <div className="mt-4 max-w-sm">
          <Field
            label="Default week starts on"
            type="select"
            value={workspace.settings.default_week_start_day}
            onChange={(v) => saveSettings({ default_week_start_day: Number(v) })}
            options={weekdayOptions}
          />
        </div>
      </Card>

      <Card title="Weekly goal overrides" icon={BarChart3}>
        <button type="button" onClick={() => saveWeek(newWeek(command))} className="mb-4 rounded-2xl bg-indigo-600 px-4 py-3 font-black text-white">
          Add weekly override
        </button>
        <EditableList
          items={workspace.weeks}
          empty="No custom weekly goals yet."
          render={(week) => (
            <WeekMiniEditor
              week={week}
              onChange={saveWeek}
              onDelete={() => removeWeek(week.id)}
            />
          )}
        />
      </Card>

      <Card title="Sprint and custom goal periods" icon={Flame}>
        <button type="button" onClick={() => saveGoalPeriod(newGoalPeriod(workspace.plan.id))} className="mb-4 rounded-2xl bg-emerald-600 px-4 py-3 font-black text-white">
          Add sprint goal
        </button>
        <EditableList
          items={workspace.goalPeriods}
          empty="No sprint goals yet."
          render={(period) => (
            <GoalPeriodMiniEditor
              period={period}
              onChange={saveGoalPeriod}
              onDelete={() => removeGoalPeriod(period.id)}
            />
          )}
        />
      </Card>
    </div>
  );
}

function IncentivesPage({ command, workspace, saveIncentive, removeIncentive }) {
  return (
    <div className="grid gap-5">
      <Card title="Rewards and incentives" icon={Gift}>
        <button type="button" onClick={() => saveIncentive(newIncentive(workspace.plan.id))} className="rounded-2xl bg-purple-600 px-4 py-3 font-black text-white">
          Add incentive
        </button>
        {!command.incentives.length && (
          <div className="mt-4 rounded-3xl bg-purple-50 p-5 text-sm font-bold text-purple-800">
            If you add a reward, this page will track your progress toward it.
          </div>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {command.incentives.map((item) => (
          <IncentiveCard key={item.id} incentive={item} onSave={saveIncentive} onDelete={() => removeIncentive(item.id)} />
        ))}
      </div>
    </div>
  );
}

function IncentiveCard({ incentive, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="overflow-hidden rounded-[2rem] bg-white shadow-card">
      <div className="bg-gradient-to-br from-purple-600 to-amber-400 p-1">
        <div className="rounded-[1.75rem] bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-2xl font-black">{incentive.title}</div>
              <p className="mt-2 line-clamp-2 text-sm font-semibold text-slate-500">{incentive.description || "Reward progress tracked automatically."}</p>
            </div>
            <Badge tone={incentive.status === "achieved" ? "ahead" : incentive.status === "locked" ? "neutral" : "on_track"}>
              {incentive.status.replaceAll("_", " ")}
            </Badge>
          </div>
          <Progress value={incentive.progress} tone="purple" />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm font-bold text-slate-500">
            <span>{incentive.incentive_type.replaceAll("_", " ")}</span>
            <span>{number(incentive.current, 1)} / {number(incentive.target, 1)}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setEditing(!editing)} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black">
              {editing ? "Close" : "Edit"}
            </button>
            {incentive.status === "achieved" && (
              <button type="button" onClick={() => onSave({ ...incentive, status: "claimed" })} className="rounded-2xl bg-purple-600 px-4 py-2 text-sm font-black text-white">
                Claim
              </button>
            )}
            <button type="button" onClick={onDelete} className="rounded-2xl bg-red-50 px-4 py-2 text-sm font-black text-red-700">
              Delete
            </button>
          </div>
          {editing && (
            <div className="mt-4 rounded-3xl bg-slate-50 p-4">
              <IncentiveMiniEditor incentive={incentive} onChange={onSave} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsPage({ user, workspace, saveSettings }) {
  const [blocks, setBlocks] = useState(normalizeTimeBlocks(workspace.settings.time_blocks_config));
  useEffect(() => setBlocks(normalizeTimeBlocks(workspace.settings.time_blocks_config)), [workspace.settings.time_blocks_config]);

  function updateBlock(key, changes) {
    setBlocks((current) => current.map((block) => (block.key === key ? { ...block, ...changes } : block)));
  }

  return (
    <div className="grid gap-5">
      <Card title="Account and app settings" icon={Settings}>
        <Metric label="Signed in as" value={user.email} />
        <Metric label="Active plan" value={workspace.plan.name} />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field
            label="Theme preference"
            type="select"
            value={workspace.settings.theme_preference}
            onChange={(v) => saveSettings({ theme_preference: v })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark later" },
            ]}
          />
          <Field
            label="Catch-up preference"
            type="select"
            value={workspace.settings.catchup_preference}
            onChange={(v) => saveSettings({ catchup_preference: v })}
            options={[
              { value: "balanced", label: "Balanced" },
              { value: "add_workdays", label: "Suggest adding workdays" },
              { value: "protect_rest", label: "Protect planned days off" },
            ]}
          />
        </div>
      </Card>
      <Card title="Free hosting stack" icon={CheckCircle2}>
        <div className="grid gap-3 text-sm font-bold text-slate-600">
          <div>Hosting: Vercel Hobby</div>
          <div>Auth and database: Supabase Free</div>
          <div>Frontend: React + Vite + Tailwind</div>
          <div>Charts: Recharts</div>
        </div>
      </Card>
      <Card title="Daily time blocks" icon={Clock}>
        <p className="mb-5 text-sm font-semibold text-slate-500">
          Edit how today's goal is split. Breaks can stay visible without receiving a target.
        </p>
        <div className="grid gap-3">
          {blocks.map((block) => (
            <div key={block.key} className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 md:grid-cols-[1fr_0.8fr_0.8fr_0.6fr_0.6fr_auto]">
              <Field label="Name" value={block.name} onChange={(v) => updateBlock(block.key, { name: v })} />
              <Field label="Start" type="time" value={block.start_time} onChange={(v) => updateBlock(block.key, { start_time: v })} />
              <Field label="End" type="time" value={block.end_time} onChange={(v) => updateBlock(block.key, { end_time: v })} />
              <Field label="Share" type="number" value={block.target_share} onChange={(v) => updateBlock(block.key, { target_share: v })} />
              <Field label="Weight" type="number" value={block.capacity_weight} onChange={(v) => updateBlock(block.key, { capacity_weight: v })} />
              <label className="flex items-end gap-2 pb-3 text-sm font-black text-slate-600">
                <input type="checkbox" checked={block.active} onChange={(event) => updateBlock(block.key, { active: event.target.checked })} className="h-5 w-5 accent-indigo-600" />
                Active
              </label>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => saveSettings({ time_blocks_config: blocks })} className="rounded-2xl bg-slate-950 px-5 py-3 font-black text-white">
            Save time blocks
          </button>
          <button type="button" onClick={() => setBlocks(defaultTimeBlocks)} className="rounded-2xl border border-slate-200 px-5 py-3 font-black text-slate-600">
            Reset defaults
          </button>
        </div>
      </Card>
    </div>
  );
}

function DayEditor({ day, command, onClose, onSave }) {
  const override = command.dayOverrides[day.date] || {};
  const entry = command.entriesByDate[day.date] || {};
  const [blockDrafts, setBlockDrafts] = useState(() => blockDraftsFromDay(day));
  const [draft, setDraft] = useState({
    sales_count: entry.sales_count || day.actual || 0,
    sales_notes: entry.notes || "",
    day_type: override.day_type || day.dayType || "normal",
    capacity_weight: override.capacity_weight ?? day.capacity ?? 1,
    planned_target: override.planned_target || day.plannedTarget || 0,
    custom_target: override.custom_target ?? "",
    include_in_calculations: override.include_in_calculations ?? true,
    day_notes: override.notes || "",
  });

  function setDayType(value) {
    setDraft((current) => ({
      ...current,
      day_type: value,
      capacity_weight: dayTypes[value]?.weight ?? current.capacity_weight,
      include_in_calculations: value !== "off",
    }));
  }
  function updateBlock(key, changes) {
    setBlockDrafts((current) => current.map((block) => (block.key === key ? { ...block, ...changes } : block)));
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-auto rounded-[2rem] bg-white p-5 shadow-glow">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-black uppercase tracking-wide text-indigo-600">Day editor</div>
            <h2 className="text-2xl font-black">{formatDate(day.date, { weekday: "long" })}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-2xl bg-slate-100 px-4 py-2 font-black">Close</button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Sales count" type="number" value={draft.sales_count} onChange={(v) => setDraft({ ...draft, sales_count: v })} />
          <Field
            label="Workday type"
            type="select"
            value={draft.day_type}
            onChange={setDayType}
            options={Object.entries(dayTypes).map(([value, meta]) => ({ value, label: meta.label }))}
          />
          <Field label="Capacity weight" type="number" value={draft.capacity_weight} onChange={(v) => setDraft({ ...draft, capacity_weight: v })} />
          <Field label="Custom target" type="number" value={draft.custom_target} onChange={(v) => setDraft({ ...draft, custom_target: v })} />
        </div>
        <Toggle label="Include this day in goal calculations" checked={draft.include_in_calculations} onChange={(v) => setDraft({ ...draft, include_in_calculations: v })} />
        <div className="mt-4 grid gap-4">
          <Field label="Sales notes" type="textarea" value={draft.sales_notes} onChange={(v) => setDraft({ ...draft, sales_notes: v })} />
          <Field label="Schedule notes" type="textarea" value={draft.day_notes} onChange={(v) => setDraft({ ...draft, day_notes: v })} />
        </div>
        <div className="mt-5 rounded-[1.5rem] bg-slate-50 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-black uppercase tracking-wide text-slate-500">Time blocks</div>
              <div className="text-sm font-bold text-slate-600">
                Total: {number(blockDrafts.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0))} / {number(day.plannedTarget, 1)}
              </div>
            </div>
            <Badge tone={statusTone(day.timeBlocks?.message || day.status)}>{day.status}</Badge>
          </div>
          <div className="grid gap-3">
            {blockDrafts.map((block) => (
              <div key={block.key} className="grid gap-3 rounded-2xl bg-white p-3 md:grid-cols-[1.1fr_0.7fr_0.7fr_1.4fr]">
                <div className="min-w-0">
                  <div className="truncate font-black">{block.name}</div>
                  <div className="text-xs font-bold text-slate-500">{block.start_time} - {block.end_time}</div>
                </div>
                <Field label="Target" type="number" value={block.target_sales ?? block.target ?? 0} onChange={(v) => updateBlock(block.key, { target_sales: v, target: Number(v) })} />
                <Field label="Actual" type="number" value={block.actual_sales ?? block.actual ?? 0} onChange={(v) => updateBlock(block.key, { actual_sales: v })} />
                <Field label="Notes" value={block.notes || ""} onChange={(v) => updateBlock(block.key, { notes: v })} />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-5 rounded-3xl bg-indigo-50 p-4 text-sm font-bold text-indigo-800">
          If you hit {number(Number(draft.sales_count || 0) + Math.max(0, command.salesNeededToday), 1)} today, your remaining daily pace moves to about {number(command.requiredPerWorkday, 1)}/day.
        </div>
        <button
          type="button"
          onClick={() => onSave({ ...draft, time_blocks: blockDrafts })}
          className="mt-5 w-full rounded-2xl bg-slate-950 px-5 py-4 font-black text-white"
        >
          Save day
        </button>
      </div>
    </div>
  );
}

function WeekCard({ week, command, saveWeek, removeWeek, saveDay }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(week);
  const weekDays = command.dayPlans.filter((day) => day.date >= week.week_start && day.date <= week.week_end);
  return (
    <div className="rounded-[2rem] bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-black text-slate-500">{week.range_label || "Sales week"}</div>
          <h3 className="text-xl font-black">{formatRange(week.week_start, week.week_end)}</h3>
        </div>
        <Badge tone={week.status === "Overloaded" ? "critical" : week.progress >= 100 ? "ahead" : "on_track"}>{week.status}</Badge>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniMetric label="Goal" value={number(week.weekly_goal)} />
        <MiniMetric label="Actual" value={number(week.actual)} />
        <MiniMetric label="Need" value={number(week.remaining, 1)} />
        <MiniMetric label="/day" value={number(week.requiredPerDay, 1)} />
      </div>
      <Progress value={week.progress} />
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => setEditing(!editing)} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black"><Edit3 size={15} className="inline" /> Edit week</button>
        {week.id && <button type="button" onClick={() => removeWeek(week.id)} className="rounded-2xl bg-red-50 px-4 py-2 text-sm font-black text-red-700">Delete override</button>}
      </div>
      {editing && (
        <div className="mt-4 rounded-3xl bg-slate-50 p-4">
          <WeekMiniEditor week={draft} onChange={setDraft} />
          <button type="button" onClick={() => saveWeek(draft)} className="mt-3 rounded-2xl bg-slate-950 px-4 py-2 font-black text-white">Save week</button>
        </div>
      )}
      <div className="mt-4 grid gap-2">
        {weekDays.slice(0, 7).map((day) => (
          <button
            key={day.date}
            type="button"
            onClick={() =>
              saveDay(day.date, {
                sales_count: day.actual,
                sales_notes: day.notes,
                day_type: day.dayType === "off" ? "normal" : "off",
                capacity_weight: day.dayType === "off" ? 1 : 0,
                planned_target: day.plannedTarget,
                custom_target: day.customTarget ?? "",
                include_in_calculations: day.dayType === "off",
                day_notes: day.dayType === "off" ? "" : "Marked off from weekly planner.",
              })
            }
            className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2 text-sm font-bold"
          >
            <span>{formatDate(day.date, { weekday: "short", year: undefined })}</span>
            <span>{day.dayType === "off" ? "Add workday" : "Mark off"}</span>
          </button>
        ))}
      </div>
      {week.requiredPerDay > command.plan.max_sales_per_day && (
        <div className="mt-4 rounded-2xl bg-amber-50 p-3 text-sm font-bold text-amber-800">
          This week is overloaded. Move sales into next week or add one workday.
        </div>
      )}
    </div>
  );
}

function CoachCard({ command }) {
  return (
    <Card title="Coach" icon={Sparkles}>
      <div className="grid gap-3">
        {command.catchup.messages.map((message) => (
          <div key={message} className="rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-700">
            {message}
          </div>
        ))}
        <div className={`rounded-2xl p-4 text-sm font-black ${command.goalRealism.key === "overloaded" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
          {command.goalRealism.label}
        </div>
      </div>
    </Card>
  );
}

function Card({ title, icon: Icon, children }) {
  return (
    <section className="glass-card rounded-[2rem] p-5">
      <div className="mb-5 flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-950 text-white">
          <Icon size={20} />
        </div>
        <h2 className="text-xl font-black">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Section({ title, icon: Icon, children }) {
  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-950 text-white">
          <Icon />
        </div>
        <h2 className="text-2xl font-black">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Stat({ icon: Icon, label, value, sub }) {
  return (
    <div className="glass-card rounded-[2rem] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-black uppercase tracking-wide text-slate-500">{label}</div>
        <Icon className="text-indigo-600" size={21} />
      </div>
      <div className="mt-4 text-4xl font-black tracking-tight">{value}</div>
      <div className="mt-2 text-sm font-bold text-slate-500">{sub}</div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", options = [], required = false }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-black text-slate-600">{label}</span>
      {type === "select" ? (
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="min-h-12 rounded-2xl border border-slate-200 bg-white px-4 font-bold outline-none focus:border-indigo-400">
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="min-h-28 rounded-2xl border border-slate-200 bg-white px-4 py-3 font-bold outline-none focus:border-indigo-400" />
      ) : (
        <input required={required} type={type} value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="min-h-12 rounded-2xl border border-slate-200 bg-white px-4 font-bold outline-none focus:border-indigo-400" />
      )}
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="mt-5 flex items-center gap-3 rounded-2xl bg-slate-50 p-4 font-bold text-slate-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-5 w-5 accent-indigo-600" />
      {label}
    </label>
  );
}

function WeekdayPicker({ value, onChange }) {
  return (
    <div>
      <div className="mb-3 text-sm font-black text-slate-600">Normal workdays</div>
      <div className="flex flex-wrap gap-2">
        {weekdayOptions.map((day) => {
          const selected = value.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              onClick={() => onChange(selected ? value.filter((item) => item !== day.value) : [...value, day.value].sort())}
              className={`rounded-2xl px-4 py-3 font-black ${selected ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}
            >
              {day.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Badge({ tone = "neutral", children }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-black capitalize ring-1 ${statusColors[tone] || statusColors.neutral}`}>
      {children}
    </span>
  );
}

function Progress({ value, tone = "blue" }) {
  const color = tone === "purple" ? "bg-purple-500" : tone === "white" ? "bg-white" : tone === "slate" ? "bg-slate-300" : "bg-indigo-600";
  return (
    <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100">
      <div className={`progress-shine h-full rounded-full ${color} transition-all duration-500`} style={{ width: percent(value) }} />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-0">
      <span className="font-bold text-slate-500">{label}</span>
      <strong className="text-right">{value}</strong>
    </div>
  );
}

function MiniMetric({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-black">{value}</div>
    </div>
  );
}

function EditableList({ items, empty, render }) {
  return (
    <div className="mt-5 grid gap-3">
      {items.length ? items.map((item, index) => <div key={item.id || index}>{render(item, index)}</div>) : <div className="rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-500">{empty}</div>}
    </div>
  );
}

function WeekMiniEditor({ week, onChange, onDelete }) {
  return (
    <div className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 md:grid-cols-5">
      <Field label="Label" value={week.range_label || ""} onChange={(v) => onChange({ ...week, range_label: v })} />
      <Field label="Start" type="date" value={week.week_start} onChange={(v) => onChange({ ...week, week_start: v })} />
      <Field label="End" type="date" value={week.week_end} onChange={(v) => onChange({ ...week, week_end: v })} />
      <Field label="Goal" type="number" value={week.weekly_goal} onChange={(v) => onChange({ ...week, weekly_goal: v, custom_goal_enabled: true })} />
      {onDelete && <button type="button" onClick={onDelete} className="self-end rounded-2xl bg-red-50 px-4 py-3 font-black text-red-700">Delete</button>}
    </div>
  );
}

function DayMiniEditor({ day, onChange, onDelete }) {
  return (
    <div className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 md:grid-cols-5">
      <Field label="Date" type="date" value={day.date} onChange={(v) => onChange({ ...day, date: v })} />
      <Field label="Type" type="select" value={day.day_type} onChange={(v) => onChange({ ...day, day_type: v, capacity_weight: dayTypes[v]?.weight ?? day.capacity_weight })} options={Object.entries(dayTypes).map(([value, meta]) => ({ value, label: meta.label }))} />
      <Field label="Weight" type="number" value={day.capacity_weight} onChange={(v) => onChange({ ...day, capacity_weight: v })} />
      <Field label="Notes" value={day.notes || ""} onChange={(v) => onChange({ ...day, notes: v })} />
      {onDelete && <button type="button" onClick={onDelete} className="self-end rounded-2xl bg-red-50 px-4 py-3 font-black text-red-700">Delete</button>}
    </div>
  );
}

function GoalPeriodMiniEditor({ period, onChange, onDelete }) {
  return (
    <div className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 md:grid-cols-6">
      <Field label="Title" value={period.title} onChange={(v) => onChange({ ...period, title: v })} />
      <Field label="Type" type="select" value={period.period_type} onChange={(v) => onChange({ ...period, period_type: v })} options={[{ value: "sprint", label: "Sprint" }, { value: "push", label: "Push period" }, { value: "pause", label: "Pause" }, { value: "custom", label: "Custom" }]} />
      <Field label="Start" type="date" value={period.start_date} onChange={(v) => onChange({ ...period, start_date: v })} />
      <Field label="End" type="date" value={period.end_date} onChange={(v) => onChange({ ...period, end_date: v })} />
      <Field label="Target" type="number" value={period.target_sales} onChange={(v) => onChange({ ...period, target_sales: v })} />
      {onDelete && <button type="button" onClick={onDelete} className="self-end rounded-2xl bg-red-50 px-4 py-3 font-black text-red-700">Delete</button>}
    </div>
  );
}

function IncentiveMiniEditor({ incentive, onChange, onDelete }) {
  return (
    <div className="grid gap-3 md:grid-cols-6">
      <Field label="Reward" value={incentive.title} onChange={(v) => onChange({ ...incentive, title: v })} />
      <Field label="Type" type="select" value={incentive.incentive_type} onChange={(v) => onChange({ ...incentive, incentive_type: v })} options={[{ value: "sales_milestone", label: "Sales milestone" }, { value: "weekly_goal", label: "Weekly goal" }, { value: "streak", label: "Streak" }, { value: "season_goal", label: "Season goal" }, { value: "sprint_goal", label: "Sprint goal" }, { value: "custom", label: "Custom" }]} />
      <Field label="Target" type="number" value={incentive.target_value} onChange={(v) => onChange({ ...incentive, target_value: v })} />
      <Field label="Value/cost" type="number" value={incentive.reward_value || ""} onChange={(v) => onChange({ ...incentive, reward_value: v })} />
      <Field label="Description" value={incentive.description || ""} onChange={(v) => onChange({ ...incentive, description: v })} />
      {onDelete && <button type="button" onClick={onDelete} className="self-end rounded-2xl bg-red-50 px-4 py-3 font-black text-red-700">Delete</button>}
    </div>
  );
}

function blockDraftsFromDay(day) {
  if (!day?.timeBlocks?.blocks) return [];
  return day.timeBlocks.blocks.map((block) => ({
    key: block.key,
    name: block.name,
    start_time: block.start_time,
    end_time: block.end_time,
    active: block.active,
    is_break: block.is_break,
    target_share: block.target_share,
    target: block.target,
    target_sales: block.target,
    actual: block.actual,
    actual_sales: block.actual,
    notes: block.notes || "",
    status: block.status,
    capacity_weight: block.capacity_weight,
    include_in_calculations: block.status !== "Skipped",
    isCurrent: block.isCurrent,
    minutesLeft: block.minutesLeft,
  }));
}

function LoadingScreen() {
  return <div className="grid min-h-screen place-items-center text-xl font-black text-slate-600">Loading your command center...</div>;
}

function heroMessage(command) {
  if (command.paceStatus.key === "ahead") return "You're ahead. Protect the lead.";
  if (command.paceStatus.key === "behind") return `You're behind by ${number(Math.abs(command.aheadBehind), 1)} sales. Catch-up mode is active.`;
  if (command.paceStatus.key === "critical") return "Your plan needs adjustment. Add capacity or revise the date range.";
  return "Push today, future you gets relief.";
}

function statusTone(status) {
  const lower = String(status).toLowerCase();
  if (lower.includes("ahead")) return "ahead";
  if (lower.includes("track") || lower.includes("planned")) return "on_track";
  if (lower.includes("behind") || lower.includes("push")) return "behind";
  if (lower.includes("critical") || lower.includes("missed")) return "critical";
  return "neutral";
}

function getCalendarRange(mode, anchor, customStart, customEnd, command) {
  if (mode === "week") return { start: toISO(weekStart(parseISO(anchor), command.settings.default_week_start_day)), end: toISO(weekEnd(parseISO(anchor), command.settings.default_week_start_day)) };
  if (mode === "month") return { start: toISO(monthStart(parseISO(anchor))), end: toISO(monthEnd(parseISO(anchor))) };
  if (mode === "season") return { start: command.plan.start_date, end: command.plan.end_date };
  return { start: customStart, end: customEnd };
}

function applyDayFilter(day, filter) {
  if (filter === "active") return day.capacity > 0;
  if (filter === "off") return day.dayType === "off";
  if (filter === "missed") return day.dayType === "missed" || day.status === "Missed";
  if (filter === "priority") return day.dayType === "big_push" || day.capacity >= 1.5;
  return true;
}

function buildDatePreview(command, draft) {
  const currentCapacity = command.remainingWorkCapacity;
  const normalWorkdays = command.settings.normal_workdays || [1, 2, 3, 4, 5, 6];
  const futureStart = maxISO(todayISO(), draft.tracking_start_date || draft.start_date);
  const newDates = datesBetween(futureStart, draft.end_date);
  const newCapacity = newDates.reduce((sum, date) => {
    const parsed = parseISO(date);
    return sum + (parsed && normalWorkdays.includes(parsed.getDay()) ? 1 : 0);
  }, 0);
  const remaining = Math.max(0, Number(draft.total_goal || 0) - command.completed);
  const newPace = newCapacity > 0 ? remaining / newCapacity : 0;
  const delta = newCapacity - currentCapacity;
  return {
    warning: newPace > Number(draft.max_sales_per_day || 0),
    message: `This change gives you ${number(Math.abs(delta), 1)} ${delta >= 0 ? "more" : "fewer"} weighted workdays. Required pace changes from ${number(command.requiredPerWorkday, 1)} to ${number(newPace, 1)} sales/day.`,
  };
}

function normalizePlanDraft(draft) {
  return {
    name: draft.name,
    start_date: draft.start_date,
    end_date: draft.end_date,
    tracking_start_date: draft.tracking_start_date,
    total_goal: Number(draft.total_goal || 0),
    starting_sales: Number(draft.starting_sales || 0),
    default_weekly_goal: Number(draft.default_weekly_goal || 0),
    max_sales_per_day: Number(draft.max_sales_per_day || 0),
    catchup_strategy: draft.catchup_strategy,
    include_outside_range_sales: draft.include_outside_range_sales,
  };
}

function autoBuildWeeks(plan) {
  const weeks = [];
  let cursor = weekStart(parseISO(plan.start_date), 1);
  const seasonEnd = parseISO(plan.end_date);
  while (cursor <= seasonEnd) {
    weeks.push({
      week_start: toISO(cursor),
      week_end: toISO(weekEnd(cursor, 1)),
      weekly_goal: Number(plan.default_weekly_goal || 0),
      custom_goal_enabled: false,
      custom_range_enabled: false,
      range_label: `Week ${weeks.length + 1}`,
      notes: "",
    });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function newWeek(command) {
  const start = command.currentWeekStart;
  return {
    plan_id: command.plan.id,
    week_start: start,
    week_end: command.currentWeekEnd,
    weekly_goal: command.plan.default_weekly_goal,
    custom_goal_enabled: true,
    custom_range_enabled: true,
    range_label: "Custom week",
    notes: "",
  };
}

function newGoalPeriod(planId) {
  return {
    plan_id: planId,
    title: "New sprint",
    period_type: "sprint",
    start_date: todayISO(),
    end_date: toISO(addDays(new Date(), 13)),
    target_sales: 20,
    priority: "normal",
    active: true,
    notes: "",
  };
}

function newIncentive(planId) {
  return {
    plan_id: planId,
    title: "New reward",
    description: "",
    incentive_type: "sales_milestone",
    target_value: 25,
    reward_value: "",
    status: "locked",
  };
}

function upsertLocalByDate(items, next) {
  const exists = items.some((item) => item.date === next.date);
  return exists ? items.map((item) => (item.date === next.date ? { ...item, ...next } : item)) : [...items, next];
}

function upsertLocalById(items, next) {
  const exists = items.some((item) => item.id === next.id);
  return exists ? items.map((item) => (item.id === next.id ? { ...item, ...next } : item)) : [...items, next];
}

function upsertLocalBlocks(items, nextBlocks) {
  const keys = new Set(nextBlocks.map((block) => `${block.date}:${block.block_key}`));
  return [
    ...items.filter((item) => !keys.has(`${item.date}:${item.block_key}`)),
    ...nextBlocks,
  ].sort((a, b) => `${a.date}:${a.start_time}`.localeCompare(`${b.date}:${b.start_time}`));
}
