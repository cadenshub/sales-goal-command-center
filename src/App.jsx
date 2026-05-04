import { useEffect, useMemo, useRef, useState } from "react";
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
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  upsertWeeklyConfirmation,
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

const VERSION_CHECK_INTERVAL_MS = 60_000;

export default function App() {
  useAutoRefreshOnNewBuild();
  const [session, setSession] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDay, setSelectedDay] = useState(null);
  const [saveState, setSaveState] = useState("Saved");
  const [clockTick, setClockTick] = useState(0);
  const loadedUserIdRef = useRef(null);

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
    const { data } = onAuthChange(async (nextSession, event) => {
      setSession(nextSession);
      if (!nextSession?.user) {
        setWorkspace(null);
        loadedUserIdRef.current = null;
        setLoading(false);
        return;
      }
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (loadedUserIdRef.current !== nextSession.user.id) await bootstrapWorkspace(nextSession.user);
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
      loadedUserIdRef.current = user.id;
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

  async function saveAndPatch(patcher, saveAction, options = {}) {
    let previousWorkspace = null;
    setWorkspace((current) => {
      previousWorkspace = current;
      return patcher(current);
    });
    setSaveState("Saving...");
    try {
      await saveAction();
      setSaveState("Saved");
    } catch (err) {
      setError(err.message);
      setSaveState("Save failed");
      if (options.rollbackOnError !== false && previousWorkspace) setWorkspace(previousWorkspace);
      if (options.refetchOnError && session?.user) bootstrapWorkspace(session.user);
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
          {page === "weekly" && (
            <WeeklyPlanner
              command={command}
              saveWeek={saveWeek}
              removeWeek={removeWeek}
              saveDay={saveDay}
              saveWeeklyConfirmation={saveWeeklyConfirmation}
            />
          )}
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
      status: normalizeTimeBlockStatus(block.status),
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

  async function saveWeeklyConfirmation(week, draft) {
    const submitted = Number(week.actual || draft.submitted_sales || 0);
    const serviced = Number(draft.serviced_accounts || 0);
    const active = Number(draft.active_accounts || 0);
    const confirmed = Number(draft.confirmed_sales ?? Math.min(submitted, serviced + active));
    const payload = {
      plan_id: workspace.plan.id,
      week_start: week.week_start,
      week_end: week.week_end,
      submitted_sales: submitted,
      serviced_accounts: serviced,
      active_accounts: active,
      confirmed_sales: confirmed,
      pending_sales: Math.max(0, submitted - confirmed),
      notes: draft.notes || "",
      confirmed_at: new Date().toISOString(),
    };
    await saveAndPatch(
      (current) => ({
        ...current,
        weeklyConfirmations: upsertLocalConfirmation(current.weeklyConfirmations || [], payload),
      }),
      async () => {
        const saved = await upsertWeeklyConfirmation(payload);
        setWorkspace((current) => ({
          ...current,
          weeklyConfirmations: upsertLocalConfirmation(current.weeklyConfirmations || [], saved),
        }));
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
    const title = String(incentive.title || "").trim();
    if (!title) throw new Error("Reward name is required.");
    const payload = {
      ...(incentive.id ? { id: incentive.id } : {}),
      plan_id: workspace.plan.id,
      title,
      description: String(incentive.description || "").trim(),
      incentive_type: incentive.incentive_type || "sales_milestone",
      target_value: Number(incentive.target_value || 0),
      target_date: incentive.target_date || null,
      related_goal_period_id: incentive.related_goal_period_id || null,
      reward_value: incentive.reward_value === "" || incentive.reward_value === null ? null : Number(incentive.reward_value || 0),
      status: incentive.status || "locked",
    };
    await saveAndPatch(
      (current) => ({
        ...current,
        incentives: payload.id ? upsertLocalById(current.incentives, payload) : current.incentives,
      }),
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

function useAutoRefreshOnNewBuild() {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let active = true;
    let currentBuildId = null;

    async function readVersion() {
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const version = await response.json();
        if (!active || !version?.buildId) return;
        if (!currentBuildId) {
          currentBuildId = version.buildId;
          return;
        }
        if (version.buildId !== currentBuildId) {
          window.location.reload();
        }
      } catch {
        // Version checks should never interrupt sales entry.
      }
    }

    function checkWhenVisible() {
      if (document.visibilityState === "visible") readVersion();
    }

    readVersion();
    const timer = window.setInterval(checkWhenVisible, VERSION_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("focus", checkWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("focus", checkWhenVisible);
    };
  }, []);
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
    <div className="grid gap-4">
      <CoachSummary command={command} />
      <TodaySalesCard command={command} onSaveDay={onSaveDay} />

      <section className="grid gap-4 lg:grid-cols-2">
        <CompactWeekCard command={command} />
        <Card title="Season" icon={Target} compact>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-3xl font-black">{percent(completion)}</div>
              <div className="mt-1 text-sm font-bold text-slate-500">
                {number(command.completed)} of {number(command.plan.total_goal)} sales
              </div>
            </div>
            <Badge tone={command.paceStatus.key}>{command.paceStatus.label}</Badge>
          </div>
          <Progress value={completion} />
          <div className="mt-3 text-sm font-bold text-slate-500">
            {number(command.remaining)} remaining · {number(command.requiredPerWorkday, 1)} per workday
          </div>
        </Card>
      </section>
      <RewardSummary command={command} setPage={setPage} />
    </div>
  );
}

function CoachSummary({ command }) {
  const rewardMessage = command.nextIncentive
    ? `You are ${number(Math.max(0, command.nextIncentive.target - command.nextIncentive.current), 1)} away from ${command.nextIncentive.title}.`
    : "Log sales by block to keep the day accurate.";
  const message =
    command.todayPlan?.dayType === "off"
      ? "Today is off. Bonus sales still count."
      : command.salesNeededToday > 0
        ? `You need ${number(command.salesNeededToday, 1)} sales today to stay on pace.`
        : rewardMessage;
  return (
    <section className="glass-card rounded-3xl p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-slate-950 text-white">
          <Sparkles size={18} />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-black uppercase tracking-wide text-slate-400">Coach</div>
          <p className="mt-1 text-base font-black leading-6 text-slate-950">{message}</p>
        </div>
      </div>
    </section>
  );
}

function RewardSummary({ command, setPage }) {
  return (
    <Card title="Next reward" icon={Gift} compact>
      {command.nextIncentive ? (
        <>
          <div className="min-w-0 text-xl font-black break-words">{command.nextIncentive.title}</div>
          <Progress value={command.nextIncentive.progress} tone="purple" />
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm font-bold text-slate-500">
            <span>{number(command.nextIncentive.current, 1)} / {number(command.nextIncentive.target, 1)}</span>
            <span>{number(Math.max(0, command.nextIncentive.target - command.nextIncentive.current), 1)} away</span>
          </div>
        </>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm font-bold text-slate-500">No reward yet. Add one to make the next milestone more fun.</p>
          <button type="button" onClick={() => setPage("incentives")} className="rounded-2xl bg-purple-600 px-4 py-3 font-black text-white">
            Add reward
          </button>
        </div>
      )}
    </Card>
  );
}

function CompactWeekCard({ command }) {
  const progress = (command.currentWeekActual / Math.max(1, command.currentWeek.weekly_goal)) * 100;
  const message =
    command.currentWeekRemaining <= 0
      ? "Strong week. Protect the lead."
      : `${number(command.currentWeekRemaining, 1)} sales needed this week.`;
  return (
    <Card title="This week" icon={Calendar} compact>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-bold text-slate-500">{formatRange(command.currentWeek.week_start, command.currentWeek.week_end)}</div>
          <div className="mt-1 text-2xl font-black">{number(command.currentWeekActual)} / {number(command.currentWeek.weekly_goal)}</div>
        </div>
        <Badge tone={command.currentWeekRemaining <= 0 ? "ahead" : command.requiredThisWeek > command.plan.max_sales_per_day ? "critical" : "on_track"}>
          {command.currentWeekRemaining <= 0 ? "Ahead" : "Active"}
        </Badge>
      </div>
      <Progress value={progress} />
      <div className="mt-3 text-sm font-bold text-slate-500">
        {message} {command.currentWeekCapacity > 0 ? `${number(command.requiredThisWeek, 1)} per workday.` : ""}
      </div>
    </Card>
  );
}

function TodaySalesCard({ command, onSaveDay }) {
  const today = command.todayPlan;
  const [notes, setNotes] = useState(today?.notes || "");
  const [manualSales, setManualSales] = useState(today?.actual || 0);
  const [blockDrafts, setBlockDrafts] = useState(() => blockDraftsFromDay(today));
  const [editOpen, setEditOpen] = useState(false);
  const [showAllBlocks, setShowAllBlocks] = useState(false);
  const [addSalesOpen, setAddSalesOpen] = useState(false);
  const [logAmount, setLogAmount] = useState(1);
  const [selectedBlockKey, setSelectedBlockKey] = useState("");
  const lastTodaySyncKeyRef = useRef("");
  const visibleBlocks = blockDrafts.filter((block) => block.active && !block.is_break);
  const currentBlock = visibleBlocks.find((block) => block.isCurrent) || today?.timeBlocks.currentBlock;
  const todaySyncKey = today
    ? [
        today.date,
        today.actual,
        today.notes || "",
        ...(today.timeBlocks?.blocks || []).map((block) =>
          `${block.key}:${block.actual}:${block.target}:${block.status}:${block.isCurrent ? "current" : ""}`,
        ),
      ].join("|")
    : "";

  useEffect(() => {
    setEditOpen(false);
    setShowAllBlocks(false);
    setAddSalesOpen(false);
    setLogAmount(1);
    setSelectedBlockKey("");
    lastTodaySyncKeyRef.current = "";
  }, [today?.date]);

  useEffect(() => {
    if (lastTodaySyncKeyRef.current === todaySyncKey) return;
    lastTodaySyncKeyRef.current = todaySyncKey;
    setNotes(today?.notes || "");
    setManualSales(today?.actual || 0);
    setBlockDrafts(blockDraftsFromDay(today));
  }, [today, todaySyncKey]);

  if (!today) return null;

  const totalActual = blockDrafts.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0);
  const totalTarget = today.plannedTarget;
  const remaining = Math.max(0, totalTarget - totalActual);
  const activeBlock = currentBlock && !currentBlock.is_break ? currentBlock : visibleBlocks.find((block) => !block.isPast) || visibleBlocks[0];
  const selectedBlock = visibleBlocks.find((block) => block.key === selectedBlockKey) || activeBlock || visibleBlocks[0];
  const selectedBlockActual = Number(selectedBlock?.actual_sales || 0);
  const selectedBlockTarget = Number(selectedBlock?.target || 0);
  const dailyProgress = (totalActual / Math.max(1, totalTarget)) * 100;
  const dayHelpText =
    today.dayType === "off"
      ? "Today is marked off. Bonus sales still count."
      : remaining <= 0
        ? "Daily goal covered. Extra sales count."
        : `${number(remaining, 1)} sales left for today's goal.`;

  async function logSale() {
    const key = selectedBlock?.key;
    if (!key) return;
    const amount = Math.max(1, Number(logAmount || 1));
    const updatedBlocks = blockDrafts.map((block) =>
      block.key === key
        ? { ...block, actual_sales: Number(block.actual_sales || 0) + amount, status: "current" }
        : block,
    );
    const updatedTotal = Number(manualSales || 0) + amount;
    setManualSales(updatedTotal);
    setBlockDrafts(updatedBlocks);
    await save(updatedBlocks, updatedTotal, key);
  }

  async function clearToday() {
    if (!window.confirm("Clear all sales for today?")) return;
    const clearedBlocks = blockDrafts.map((block) => ({ ...block, actual_sales: 0 }));
    setManualSales(0);
    setBlockDrafts(clearedBlocks);
    await save(clearedBlocks, 0);
  }

  async function clearBlock(blockToClear) {
    if (!blockToClear) return;
    if (!window.confirm(`Clear ${blockToClear.name} sales?`)) return;
    const currentValue = Number(blockToClear.actual_sales || 0);
    const nextTotal = Math.max(0, Number(manualSales || 0) - currentValue);
    const clearedBlocks = blockDrafts.map((block) => (block.key === blockToClear.key ? { ...block, actual_sales: 0 } : block));
    setManualSales(nextTotal);
    setBlockDrafts(clearedBlocks);
    await save(clearedBlocks, nextTotal, blockToClear.key);
  }

  async function save(blocks = blockDrafts, totalOverride = manualSales, activeKey = activeBlock?.key) {
    const currentTotal = blocks.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0);
    const diff = Number(totalOverride || 0) - currentTotal;
    const blocksToSave =
      diff !== 0 && activeKey
        ? blocks.map((block) =>
            block.key === activeKey
              ? { ...block, actual_sales: Math.max(0, Number(block.actual_sales || 0) + diff) }
              : block,
          )
        : blocks;
    await onSaveDay(today.date, {
      sales_count: totalOverride,
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
    <section className="glass-card rounded-3xl p-3.5 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-black uppercase tracking-wide text-indigo-600">Sales for today</div>
          <h2 className="mt-1 truncate text-xl font-black tracking-tight">{formatDate(today.date, { weekday: "short", month: "short", day: "numeric" })}</h2>
        </div>
        <Badge tone={statusTone(today.status)}>{today.status}</Badge>
      </div>

      <div className="mt-3 rounded-2xl bg-gradient-to-r from-indigo-50 via-white to-emerald-50 p-3 ring-1 ring-slate-200">
        <div className="flex items-center justify-between gap-3 text-sm font-black">
          <span className="text-slate-600">Daily progress</span>
          <span className="shrink-0 text-slate-950">{number(totalActual)} / {number(totalTarget, 1)} sales</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-500" style={{ width: `${Math.min(100, dailyProgress)}%` }} />
        </div>
      </div>

      <p className="mt-2 text-sm font-bold text-slate-500">{dayHelpText}</p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <CompactMetric label="Done" value={number(totalActual)} />
        <CompactMetric label="Goal" value={number(totalTarget, 1)} />
      </div>

      <div className="mt-3 rounded-3xl bg-slate-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-black uppercase tracking-wide text-slate-500">Add sales</div>
            <div className="text-xs font-bold text-slate-500">Choose a block and amount.</div>
          </div>
          <button
            type="button"
            onClick={() => setAddSalesOpen((value) => !value)}
            className="rounded-2xl bg-white px-3 py-2 text-sm font-black text-slate-700 ring-1 ring-slate-200"
          >
            {addSalesOpen ? "Close" : "Add Sales"}
          </button>
        </div>
        {addSalesOpen && (
          <div className="mt-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200">
            <div className="flex flex-wrap gap-1.5">
              {visibleBlocks.map((block) => {
                const selected = block.key === selectedBlock?.key;
                return (
                  <button
                    key={block.key}
                    type="button"
                    onClick={() => setSelectedBlockKey(block.key)}
                    className={`rounded-xl px-2.5 py-2 text-xs font-black transition ${
                      selected ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {block.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 grid grid-cols-5 gap-1.5">
              {[1, 2, 3, 4, 5].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setLogAmount(amount)}
                  className={`min-h-10 rounded-xl text-sm font-black ${
                    Number(logAmount) === amount ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {amount}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
              <input
                aria-label="Custom sales amount"
                type="number"
                min="1"
                value={logAmount}
                onChange={(event) => setLogAmount(Math.max(1, Number(event.target.value || 1)))}
                className="min-h-11 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-center font-black outline-none focus:border-emerald-400"
              />
              <button type="button" onClick={logSale} className="min-h-11 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white shadow-card">
                Log Sales
              </button>
            </div>
          </div>
        )}
        <div className="mt-2 text-xs font-bold text-slate-500">
          {addSalesOpen ? "Choose an amount, then log it." : "Tap Add Sales to choose a block and quantity."} {selectedBlock?.name || "Selected block"}: {number(selectedBlockActual)} / {number(selectedBlockTarget, 1)} logged.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setEditOpen((value) => !value)}
            className="rounded-2xl bg-white px-3 py-3 text-xs font-black text-slate-700 ring-1 ring-slate-200"
          >
            {editOpen ? "Close" : "Edit"}
          </button>
          <button type="button" onClick={clearToday} className="rounded-2xl bg-red-50 px-3 py-3 text-xs font-black text-red-700">
            Clear day
          </button>
        </div>
      </div>

      {editOpen && (
        <div className="mt-3 rounded-3xl bg-slate-50 p-4">
          <div className="grid gap-3 md:grid-cols-[0.4fr_1fr]">
            <Field label="Manual total" type="number" value={manualSales} onChange={setManualSales} />
            <Field label="Notes" value={notes} onChange={setNotes} />
          </div>
          <button type="button" onClick={() => save()} className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-4 font-black text-white shadow-card">
            Save changes
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowAllBlocks((value) => !value)}
        className="mt-3 w-full rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700"
      >
        {showAllBlocks ? "Hide full day" : "View full day"}
      </button>

      {showAllBlocks && (
      <div className="mt-3 grid gap-2">
        {visibleBlocks.map((block) => (
          <div
            key={block.key}
            className={`rounded-2xl border p-3 ${
              block.isCurrent ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-black">{block.name}</div>
                <div className="text-xs font-bold text-slate-500">{block.start_time} - {block.end_time}</div>
              </div>
              <div className="shrink-0 text-sm font-black text-slate-600">
                {number(block.actual_sales || 0)} / {number(block.target || 0, 1)}
              </div>
            </div>
            <Progress value={(Number(block.actual_sales || 0) / Math.max(1, Number(block.target || 0))) * 100} tone="purple" />
            <button
              type="button"
              onClick={() => clearBlock(block)}
              disabled={Number(block.actual_sales || 0) <= 0}
              className="mt-2 rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear {block.name}
            </button>
          </div>
        ))}
      </div>
      )}
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
            className={`min-h-36 rounded-3xl border p-4 text-left shadow-card transition hover:-translate-y-1 hover:shadow-glow ${
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
                <div className="mt-1 text-2xl font-black">{parseISO(day.date).getDate()}</div>
              </div>
              <Badge tone={statusTone(day.status)}>{day.status}</Badge>
            </div>
            <div className="mt-4 rounded-2xl bg-white/70 px-3 py-3">
              <div className="text-xl font-black">{number(day.actual)} / {number(day.plannedTarget, 1)}</div>
              <div className="text-xs font-black uppercase tracking-wide text-slate-400">sales</div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-sm font-bold text-slate-600">
              <span className="truncate">{dayTypes[day.dayType]?.label || "Custom"}</span>
              <span>{day.capacity > 0 ? `${number(day.capacity, 1)}x` : "Off"}</span>
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

function WeeklyPlanner({ command, saveWeek, removeWeek, saveDay, saveWeeklyConfirmation }) {
  const currentWeek = command.weeks.find((week) => week.week_start === command.currentWeek.week_start && week.week_end === command.currentWeek.week_end) || command.currentWeek;
  return (
    <div className="grid gap-5">
      <WeeklyConfirmationCard week={currentWeek} onSave={saveWeeklyConfirmation} />
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

function WeeklyConfirmationCard({ week, onSave }) {
  const confirmation = week.confirmation || {};
  const [draft, setDraft] = useState({
    serviced_accounts: confirmation.serviced_accounts ?? week.actual ?? 0,
    active_accounts: confirmation.active_accounts ?? 0,
    confirmed_sales: confirmation.confirmed_sales ?? week.actual ?? 0,
    notes: confirmation.notes || "",
  });
  const pending = Math.max(0, Number(week.actual || 0) - Number(draft.confirmed_sales || 0));

  useEffect(() => {
    setDraft({
      serviced_accounts: confirmation.serviced_accounts ?? week.actual ?? 0,
      active_accounts: confirmation.active_accounts ?? 0,
      confirmed_sales: confirmation.confirmed_sales ?? week.actual ?? 0,
      notes: confirmation.notes || "",
    });
  }, [week.week_start, week.week_end, week.actual, confirmation.serviced_accounts, confirmation.active_accounts, confirmation.confirmed_sales, confirmation.notes]);

  return (
    <Card title="End-of-week confirmation" icon={CheckCircle2}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MiniMetric label="Submitted" value={number(week.actual)} />
        <MiniMetric label="Serviced" value={number(draft.serviced_accounts)} />
        <MiniMetric label="Active" value={number(draft.active_accounts)} />
        <MiniMetric label="Confirmed" value={number(draft.confirmed_sales)} />
        <MiniMetric label="Pending" value={number(pending)} />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <Field label="Serviced accounts" type="number" value={draft.serviced_accounts} onChange={(v) => setDraft({ ...draft, serviced_accounts: v })} />
        <Field label="Active accounts" type="number" value={draft.active_accounts} onChange={(v) => setDraft({ ...draft, active_accounts: v })} />
        <Field label="Confirmed sales" type="number" value={draft.confirmed_sales} onChange={(v) => setDraft({ ...draft, confirmed_sales: v })} />
      </div>
      <div className="mt-4">
        <Field label="Confirmation notes" value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setDraft({ ...draft, serviced_accounts: week.actual, active_accounts: 0, confirmed_sales: week.actual })}
          className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black"
        >
          Confirm all submitted
        </button>
        <button type="button" onClick={() => onSave(week, draft)} className="rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-black text-white">
          Save confirmation
        </button>
      </div>
      <div className="mt-4 rounded-2xl bg-slate-50 p-3 text-sm font-bold text-slate-600">
        Weekly goal: {number(week.weekly_goal)}. Confirmed difference: {number(Number(draft.confirmed_sales || 0) - Number(week.weekly_goal || 0), 1)}.
      </div>
    </Card>
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
  const [editingReward, setEditingReward] = useState(null);
  const rewards = dedupeById(command.incentives).filter((item) => String(item.title || "").trim());
  return (
    <div className="grid gap-5">
      <Card title="Rewards" icon={Gift}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm font-bold text-slate-500">
            Keep this simple: set a reward, pick the goal number, and let the app track progress.
          </p>
          <button type="button" onClick={() => setEditingReward(newIncentive(workspace.plan.id))} className="rounded-2xl bg-purple-600 px-5 py-3 font-black text-white">
            Add Reward
          </button>
        </div>
        {!rewards.length && (
          <div className="mt-5 rounded-3xl bg-purple-50 p-5 text-sm font-bold text-purple-800">
            No rewards yet. Add your first reward to make hitting your goals more fun.
          </div>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {rewards.map((item) => (
          <RewardCard
            key={item.id}
            incentive={item}
            onEdit={() => setEditingReward(item)}
            onClaim={() => saveIncentive({ ...item, status: "claimed" })}
            onDelete={() => removeIncentive(item.id)}
          />
        ))}
      </div>
      {editingReward && (
        <RewardModal
          incentive={editingReward}
          onClose={() => setEditingReward(null)}
          onSave={async (draft) => {
            await saveIncentive(draft);
            setEditingReward(null);
          }}
        />
      )}
    </div>
  );
}

function RewardCard({ incentive, onEdit, onClaim, onDelete }) {
  return (
    <div className="overflow-hidden rounded-[2rem] bg-white shadow-card">
      <div className="bg-gradient-to-br from-purple-600 to-amber-400 p-1">
        <div className="rounded-[1.75rem] bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="break-words text-2xl font-black">{incentive.title}</div>
              <div className="mt-2 text-sm font-bold capitalize text-slate-500">{incentive.incentive_type.replaceAll("_", " ")}</div>
            </div>
            <Badge tone={incentive.status === "achieved" ? "ahead" : incentive.status === "locked" ? "neutral" : "on_track"}>
              {incentive.status.replaceAll("_", " ")}
            </Badge>
          </div>
          <Progress value={incentive.progress} tone="purple" />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm font-bold text-slate-500">
            <span>{number(incentive.current, 1)} / {number(incentive.target, 1)}</span>
            <span>{percent(incentive.progress)}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onEdit} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black">
              Edit
            </button>
            {incentive.status === "achieved" && (
              <button type="button" onClick={onClaim} className="rounded-2xl bg-purple-600 px-4 py-3 text-sm font-black text-white">
                Claim
              </button>
            )}
            <button type="button" onClick={onDelete} className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-black text-red-700">
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RewardModal({ incentive, onSave, onClose }) {
  const [draft, setDraft] = useState(() => ({ ...incentive }));
  const [more, setMore] = useState(Boolean(incentive.description || incentive.reward_value || incentive.target_date));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (isSubmitting) return;
    const title = String(draft.title || "").trim();
    if (!title) {
      setFormError("Reward name is required.");
      return;
    }
    setIsSubmitting(true);
    setFormError("");
    try {
      await onSave({ ...draft, title });
    } catch (err) {
      setFormError(err.message);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-slate-950/45 sm:place-items-center">
      <form onSubmit={submit} className="max-h-[92vh] w-full overflow-auto rounded-t-[2rem] bg-white p-5 shadow-glow sm:max-w-xl sm:rounded-[2rem]">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-black uppercase tracking-wide text-purple-600">Reward</div>
            <h2 className="text-2xl font-black">{draft.id ? "Edit reward" : "Add reward"}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-2xl bg-slate-100 px-4 py-2 font-black">
            Cancel
          </button>
        </div>
        <div className="grid gap-4">
          <Field label="Reward name" value={draft.title} required onChange={(v) => setDraft({ ...draft, title: v })} />
          <Field
            label="Reward type"
            type="select"
            value={draft.incentive_type}
            onChange={(v) => setDraft({ ...draft, incentive_type: v })}
            options={[
              { value: "sales_milestone", label: "Sales milestone" },
              { value: "weekly_goal", label: "Weekly goal" },
              { value: "streak", label: "Streak" },
              { value: "season_goal", label: "Season goal" },
              { value: "custom", label: "Custom" },
            ]}
          />
          <Field label="Reward goal" type="number" value={draft.target_value} onChange={(v) => setDraft({ ...draft, target_value: v })} />
        </div>
        <button type="button" onClick={() => setMore((value) => !value)} className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700">
          {more ? "Hide more options" : "More options"}
        </button>
        {more && (
          <div className="mt-4 grid gap-4 rounded-3xl bg-slate-50 p-4">
            <Field label="Description" type="textarea" value={draft.description || ""} onChange={(v) => setDraft({ ...draft, description: v })} />
            <Field label="Reward value" type="number" value={draft.reward_value || ""} onChange={(v) => setDraft({ ...draft, reward_value: v })} />
            <Field label="Target date" type="date" value={draft.target_date || ""} onChange={(v) => setDraft({ ...draft, target_date: v })} />
          </div>
        )}
        {formError && <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{formError}</div>}
        <button type="submit" disabled={isSubmitting} className="mt-5 w-full rounded-2xl bg-purple-600 px-5 py-4 font-black text-white disabled:cursor-not-allowed disabled:opacity-60">
          {isSubmitting ? "Saving..." : "Save reward"}
        </button>
      </form>
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
      <Card title="Account / App" icon={Settings}>
        <Metric label="Signed in as" value={user.email} />
        <Metric label="Active plan" value={workspace.plan.name} />
      </Card>

      <Card title="Work schedule" icon={Calendar}>
        <WeekdayPicker value={workspace.settings.normal_workdays} onChange={(normal_workdays) => saveSettings({ normal_workdays })} />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field
            label="Week starts on"
            type="select"
            value={workspace.settings.default_week_start_day}
            onChange={(v) => saveSettings({ default_week_start_day: Number(v) })}
            options={weekdayOptions}
          />
          <Field
            label="Catch-up style"
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

      <Card title="Time blocks" icon={Clock}>
        <p className="mb-5 text-sm font-semibold text-slate-500">
          Edit how today's goal is split. Breaks can stay visible without receiving a target.
        </p>
        <div className="grid gap-3">
          {blocks.map((block) => (
            <div key={block.key} className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 md:grid-cols-[1fr_0.8fr_0.8fr_0.7fr_auto]">
              <Field label="Block name" value={block.name} onChange={(v) => updateBlock(block.key, { name: v })} />
              <Field label="Start time" type="time" value={block.start_time} onChange={(v) => updateBlock(block.key, { start_time: v })} />
              <Field label="End time" type="time" value={block.end_time} onChange={(v) => updateBlock(block.key, { end_time: v })} />
              <Field label="Goal weight" type="number" value={block.target_share} onChange={(v) => updateBlock(block.key, { target_share: v })} />
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

      <Card title="Display preferences" icon={CheckCircle2}>
        <Field
          label="Theme"
          type="select"
          value={workspace.settings.theme_preference}
          onChange={(v) => saveSettings({ theme_preference: v })}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark later" },
          ]}
        />
      </Card>

      <Card title="Danger zone" icon={AlertTriangle}>
        <div className="rounded-3xl bg-red-50 p-4 text-sm font-bold text-red-700">
          Destructive account or plan reset controls are intentionally not shown here yet. Use Supabase directly if you need a full wipe.
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
        <MiniMetric label="Submitted" value={number(week.actual)} />
        <MiniMetric label="Need" value={number(week.remaining, 1)} />
        <MiniMetric label="Days left" value={number(week.remainingCapacity, 1)} />
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
            <span className="min-w-0">
              <span className="block truncate">{formatDate(day.date, { weekday: "short", year: undefined })}</span>
              <span className="block text-xs text-slate-400">{number(day.actual)} / {number(day.plannedTarget, 1)} sales</span>
            </span>
            <span className="shrink-0">{day.dayType === "off" ? "Add workday" : "Mark off"}</span>
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

function Card({ title, icon: Icon, children, compact = false }) {
  return (
    <section className={`glass-card rounded-3xl ${compact ? "p-4" : "p-5"}`}>
      <div className={`${compact ? "mb-3" : "mb-5"} flex items-center gap-3`}>
        <div className={`${compact ? "h-10 w-10" : "h-11 w-11"} grid place-items-center rounded-2xl bg-slate-950 text-white`}>
          <Icon size={20} />
        </div>
        <h2 className={`${compact ? "text-lg" : "text-xl"} font-black`}>{title}</h2>
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

function CompactMetric({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-3 py-3">
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-black">{value}</div>
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

function statusTone(status) {
  const lower = String(status).toLowerCase();
  if (lower.includes("ahead")) return "ahead";
  if (lower.includes("track") || lower.includes("planned")) return "on_track";
  if (lower.includes("behind") || lower.includes("push")) return "behind";
  if (lower.includes("critical") || lower.includes("missed")) return "critical";
  return "neutral";
}

function normalizeTimeBlockStatus(status) {
  const value = String(status || "not_started").trim().toLowerCase().replace(/\s+/g, "_");
  if (value === "complete" || value === "completed") return "complete";
  if (value === "skipped" || value === "off") return "skipped";
  if (value === "partial" || value === "half_day") return "partial";
  return "not_started";
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

function dedupeById(items) {
  const seen = new Map();
  items.forEach((item) => {
    if (!item?.id || seen.has(item.id)) return;
    seen.set(item.id, item);
  });
  return [...seen.values()];
}

function upsertLocalBlocks(items, nextBlocks) {
  const keys = new Set(nextBlocks.map((block) => `${block.date}:${block.block_key}`));
  return [
    ...items.filter((item) => !keys.has(`${item.date}:${item.block_key}`)),
    ...nextBlocks,
  ].sort((a, b) => `${a.date}:${a.start_time}`.localeCompare(`${b.date}:${b.start_time}`));
}

function upsertLocalConfirmation(items, next) {
  const key = `${next.week_start}:${next.week_end}`;
  const exists = items.some((item) => `${item.week_start}:${item.week_end}` === key);
  return exists
    ? items.map((item) => (`${item.week_start}:${item.week_end}` === key ? { ...item, ...next } : item))
    : [...items, next];
}
