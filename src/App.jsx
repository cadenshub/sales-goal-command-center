import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  CloudSun,
  Edit3,
  Flame,
  Gift,
  Home,
  LayoutDashboard,
  LogOut,
  Moon,
  Phone,
  Plus,
  Settings,
  Sparkles,
  Sun,
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
  loadCriticalWorkspace,
  loadOptionalWorkspace,
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
  formatMonth,
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

const saleTypeOptions = [
  { key: "doors", label: "Doors", icon: Home },
  { key: "phone", label: "Phone", icon: Phone },
];

const VERSION_CHECK_INTERVAL_MS = 60_000;
const STARTUP_TIMEOUT_MS = 15_000;

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
  const [startupError, setStartupError] = useState("");
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const loadedUserIdRef = useRef(null);
  const loadingUserIdRef = useRef(null);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return undefined;
    }
    let mounted = true;
    loadInitialSession();
    const { data } = onAuthChange(async (nextSession, event) => {
      if (!mounted) return;
      setSession(nextSession);
      if (!nextSession?.user) {
        setWorkspace(null);
        loadedUserIdRef.current = null;
        loadingUserIdRef.current = null;
        setStartupError("");
        setLoading(false);
        return;
      }
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (loadingUserIdRef.current === nextSession.user.id) return;
      if (loadedUserIdRef.current !== nextSession.user.id) await bootstrapWorkspace(nextSession.user);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };

    async function loadInitialSession() {
      setLoading(true);
      setLoadingTimedOut(false);
      setStartupError("");
      try {
        const activeSession = await withTimeout(getSession(), "Supabase session restore");
        if (!mounted) return;
        setSession(activeSession);
        if (activeSession?.user) await bootstrapWorkspace(activeSession.user);
        else setLoading(false);
      } catch (err) {
        if (!mounted) return;
        console.error("Startup session load failed", err);
        setStartupError(readableError(err));
        setLoading(false);
      }
    }
    // The startup effect intentionally owns the first auth subscription only.
    // bootstrapWorkspace reads fresh refs/state and should not resubscribe auth on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loading) {
      setLoadingTimedOut(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setLoadingTimedOut(true), STARTUP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  async function bootstrapWorkspace(user) {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    loadingUserIdRef.current = user.id;
    setLoading(true);
    setLoadingTimedOut(false);
    setError("");
    setStartupError("");
    try {
      ensureProfile(user).catch((err) => console.warn("User profile sync failed", err));
      const nextWorkspace = await withTimeout(loadCriticalWorkspace(user.id), "Workspace data load");
      if (loadRequestIdRef.current !== requestId) return;
      setWorkspace(nextWorkspace);
      loadedUserIdRef.current = user.id;
      if (nextWorkspace?.plan?.id) loadOptionalWorkspaceInBackground(nextWorkspace.plan.id, requestId);
    } catch (err) {
      if (loadRequestIdRef.current !== requestId) return;
      console.error("Workspace load failed", err);
      setStartupError(readableError(err));
      setWorkspace(null);
    } finally {
      if (loadRequestIdRef.current === requestId) {
        loadingUserIdRef.current = null;
        setLoading(false);
      }
    }
  }

  async function loadOptionalWorkspaceInBackground(planId, requestId = loadRequestIdRef.current) {
    try {
      const optional = await loadOptionalWorkspace(planId);
      if (loadRequestIdRef.current !== requestId) return;
      setWorkspace((current) => (current?.plan?.id === planId ? mergeOptionalWorkspace(current, optional) : current));
    } catch (err) {
      console.warn("Optional workspace data failed to load", err);
    }
  }

  function retryStartup() {
    if (session?.user) bootstrapWorkspace(session.user);
    else window.location.reload();
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
      return true;
    } catch (err) {
      setError(err.message);
      setSaveState("Save failed");
      if (options.rollbackOnError !== false && previousWorkspace) setWorkspace(previousWorkspace);
      if (options.refetchOnError && session?.user) bootstrapWorkspace(session.user);
      return false;
    }
  }

  if (!isSupabaseConfigured) return <ConfigRequired />;
  if (loading) return <LoadingScreen timedOut={loadingTimedOut} onRetry={retryStartup} onSignOut={() => signOut()} />;
  if (!session) return <AuthPage error={startupError || error} setError={setError} />;
  if (startupError) return <StartupError error={startupError} onRetry={retryStartup} onSignOut={() => signOut()} />;
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
          {page === "calendar" && <CalendarPage command={command} onSelectDay={setSelectedDay} onSaveDay={saveDay} />}
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
      type_breakdown: normalizeSaleTypeBreakdown(block.type_breakdown, Number(block.actual_sales ?? block.actual ?? 0)),
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
    return await saveAndPatch(
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

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} took too long. Check your connection and try again.`));
    }, STARTUP_TIMEOUT_MS);
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => window.clearTimeout(timer));
  });
}

function readableError(error) {
  return error?.message || "Something went wrong while loading the app.";
}

function mergeOptionalWorkspace(current, optional) {
  return {
    ...current,
    ...optional,
    weeks: mergeByStableKey(current.weeks, optional.weeks, (item) => item.id || `${item.week_start}:${item.week_end}`),
    goalPeriods: mergeByStableKey(current.goalPeriods, optional.goalPeriods, (item) => item.id || `${item.title}:${item.start_date}:${item.end_date}`),
    weeklyConfirmations: mergeByStableKey(current.weeklyConfirmations, optional.weeklyConfirmations, (item) => item.id || `${item.week_start}:${item.week_end}`),
    incentives: mergeByStableKey(current.incentives, optional.incentives, (item) => item.id || item.title),
    savedFilters: mergeByStableKey(current.savedFilters, optional.savedFilters, (item) => item.id || item.title),
    optionalLoaded: true,
  };
}

function mergeByStableKey(current = [], incoming = [], getKey) {
  const merged = new Map();
  incoming.forEach((item) => merged.set(getKey(item), item));
  current.forEach((item) => merged.set(getKey(item), item));
  return [...merged.values()];
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
  const [showAllBlocks, setShowAllBlocks] = useState(false);
  const [addSalesOpen, setAddSalesOpen] = useState(false);
  const [logAmount, setLogAmount] = useState(1);
  const [saleType, setSaleType] = useState("doors");
  const [selectedBlockKey, setSelectedBlockKey] = useState("");
  const [logStatus, setLogStatus] = useState("idle");
  const [donePulse, setDonePulse] = useState(false);
  const lastTodaySyncKeyRef = useRef("");
  const feedbackTimerRef = useRef(null);
  const visibleBlocks = blockDrafts.filter((block) => block.active && !block.is_break);
  const currentBlock = visibleBlocks.find((block) => block.isCurrent) || today?.timeBlocks.currentBlock;
  const todaySyncKey = today
    ? [
        today.date,
        today.actual,
        today.notes || "",
        ...(today.timeBlocks?.blocks || []).map((block) =>
          `${block.key}:${block.actual}:${block.target}:${block.status}:${block.type_breakdown?.doors || 0}:${block.type_breakdown?.phone || 0}:${block.isCurrent ? "current" : ""}`,
        ),
      ].join("|")
    : "";

  useEffect(() => {
    setShowAllBlocks(false);
    setAddSalesOpen(false);
    setLogAmount(1);
    setSaleType("doors");
    setSelectedBlockKey("");
    setLogStatus("idle");
    setDonePulse(false);
    lastTodaySyncKeyRef.current = "";
  }, [today?.date]);

  useEffect(() => () => window.clearTimeout(feedbackTimerRef.current), []);

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
  const dailyProgress = (totalActual / Math.max(1, totalTarget)) * 100;
  const dayTypeTotals = blockDrafts.reduce(
    (totals, block) => {
      const breakdown = normalizeSaleTypeBreakdown(block.type_breakdown, Number(block.actual_sales || 0));
      return {
        doors: totals.doors + breakdown.doors,
        phone: totals.phone + breakdown.phone,
      };
    },
    { doors: 0, phone: 0 },
  );
  const dayHelpText =
    today.dayType === "off"
      ? "Today is marked off. Bonus sales still count."
      : remaining <= 0
        ? "Daily goal covered. Extra sales count."
        : `${number(remaining, 1)} sales left for today's goal.`;
  const logButtonText =
    logStatus === "saving" ? "Saving..." : logStatus === "added" ? "Added ✓" : logStatus === "error" ? "Try again" : "Log Sales";

  async function logSale() {
    const key = selectedBlock?.key;
    if (!key || logStatus === "saving") return;
    const amount = Math.max(1, Number(logAmount || 1));
    setLogStatus("saving");
    const updatedBlocks = blockDrafts.map((block) => {
      if (block.key !== key) return block;
      const typeBreakdown = normalizeSaleTypeBreakdown(block.type_breakdown, Number(block.actual_sales || 0));
      const nextBreakdown = {
        ...typeBreakdown,
        [saleType]: Number(typeBreakdown[saleType] || 0) + amount,
      };
      return {
        ...block,
        type_breakdown: nextBreakdown,
        actual_sales: nextBreakdown.doors + nextBreakdown.phone,
        status: "current",
      };
    });
    const updatedTotal = updatedBlocks.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0);
    setManualSales(updatedTotal);
    setBlockDrafts(updatedBlocks);
    try {
      const saved = await save(updatedBlocks, updatedTotal, key);
      window.clearTimeout(feedbackTimerRef.current);
      if (saved === false) {
        setLogStatus("error");
      } else {
        setLogStatus("added");
        setDonePulse(true);
      }
      feedbackTimerRef.current = window.setTimeout(() => {
        setLogStatus("idle");
        setDonePulse(false);
      }, 1200);
    } catch {
      setLogStatus("error");
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => setLogStatus("idle"), 1400);
    }
  }

  async function clearToday() {
    if (!window.confirm("Clear all sales for today?")) return;
    const clearedBlocks = blockDrafts.map((block) => ({ ...block, actual_sales: 0, type_breakdown: { doors: 0, phone: 0 } }));
    setManualSales(0);
    setBlockDrafts(clearedBlocks);
    await save(clearedBlocks, 0);
  }

  async function clearBlock(blockToClear) {
    if (!blockToClear) return;
    if (!window.confirm(`Clear ${blockToClear.name} sales?`)) return;
    const clearedBlocks = blockDrafts.map((block) => (block.key === blockToClear.key ? { ...block, actual_sales: 0, type_breakdown: { doors: 0, phone: 0 } } : block));
    const nextTotal = clearedBlocks.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0);
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
    return await onSaveDay(today.date, {
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
        type_breakdown: normalizeSaleTypeBreakdown(block.type_breakdown, Number(block.actual_sales || 0)),
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
        <CompactMetric
          label="Done"
          value={number(totalActual)}
          valueClassName={donePulse ? "text-emerald-600 drop-shadow-sm" : ""}
          className={donePulse ? "ring-2 ring-emerald-200 bg-emerald-50" : ""}
        />
        <CompactMetric label="Goal" value={number(totalTarget, 1)} />
      </div>

      <div className="mt-3 rounded-3xl bg-slate-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-black uppercase tracking-wide text-slate-500">Add sales</div>
          <button
            type="button"
            onClick={() => setAddSalesOpen((value) => !value)}
            className="rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm font-black text-white shadow-card transition hover:bg-indigo-700 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            {addSalesOpen ? "Close" : "Add Sales"}
          </button>
        </div>
        {addSalesOpen && (
          <div className="mt-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200">
            <div className="text-xs font-black uppercase tracking-wide text-slate-400">Block</div>
            <div className="flex flex-wrap gap-1.5">
              {visibleBlocks.map((block) => {
                const selected = block.key === selectedBlock?.key;
                const Icon = blockIcon(block);
                return (
                  <button
                    key={block.key}
                    type="button"
                    onClick={() => setSelectedBlockKey(block.key)}
                    className={`flex min-h-10 items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-black transition active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${
                      selected ? "bg-slate-950 text-white shadow-card" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    <Icon size={14} />
                    {block.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 text-xs font-black uppercase tracking-wide text-slate-400">Type</div>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {saleTypeOptions.map((option) => {
                const Icon = option.icon;
                const selected = saleType === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setSaleType(option.key)}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-black transition active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${
                      selected ? "bg-indigo-600 text-white shadow-card ring-2 ring-indigo-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    <Icon size={16} />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 text-xs font-black uppercase tracking-wide text-slate-400">Amount</div>
            <div className="mt-3 grid grid-cols-5 gap-1.5">
              {[1, 2, 3, 4, 5].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setLogAmount(amount)}
                  className={`min-h-10 rounded-xl text-sm font-black transition active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                    Number(logAmount) === amount ? "bg-emerald-600 text-white shadow-card ring-2 ring-emerald-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
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
              <button
                type="button"
                onClick={logSale}
                disabled={logStatus === "saving"}
                className={`min-h-11 min-w-[104px] rounded-xl px-4 py-2 text-sm font-black text-white shadow-card transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                  logStatus === "added" ? "bg-emerald-500" : logStatus === "error" ? "bg-red-600" : "bg-emerald-600 hover:bg-emerald-700"
                }`}
              >
                {logButtonText}
              </button>
            </div>
            {logStatus === "error" && <div className="mt-2 text-xs font-black text-red-600">Couldn’t save. Try again.</div>}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowAllBlocks((value) => !value)}
        className="mt-3 w-full rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 transition hover:bg-slate-200 active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
      >
        {showAllBlocks ? "Hide full day" : "View full day"}
      </button>

      {showAllBlocks && (
      <div className="mt-3 grid gap-2">
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-indigo-50/60 p-3 ring-1 ring-indigo-100">
          <SaleTypeMiniStat icon={Home} label="Doors" value={dayTypeTotals.doors} tone="emerald" />
          <SaleTypeMiniStat icon={Phone} label="Phone" value={dayTypeTotals.phone} tone="indigo" />
        </div>
        {visibleBlocks.map((block) => {
          const Icon = blockIcon(block);
          const breakdown = normalizeSaleTypeBreakdown(block.type_breakdown, Number(block.actual_sales || 0));
          return (
            <div
              key={block.key}
              className={`rounded-2xl border p-3 ${
                block.isCurrent ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-black">{block.name}</div>
                    <div className="text-xs font-bold text-slate-500">Total: {number(block.actual_sales || 0)}</div>
                  </div>
                </div>
                <div className="shrink-0 text-sm font-black text-slate-600">
                  {number(block.actual_sales || 0)} / {number(block.target || 0, 1)}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <SaleTypeMiniStat icon={Home} label="Doors" value={breakdown.doors} tone="emerald" />
                <SaleTypeMiniStat icon={Phone} label="Phone" value={breakdown.phone} tone="indigo" />
              </div>
              <Progress value={(Number(block.actual_sales || 0) / Math.max(1, Number(block.target || 0))) * 100} tone="purple" />
              <button
                type="button"
                onClick={() => clearBlock(block)}
                disabled={Number(block.actual_sales || 0) <= 0}
                className="mt-2 rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-red-50 hover:text-red-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
              >
                Clear {block.name}
              </button>
            </div>
          );
        })}
      </div>
      )}
      <div className="mt-3">
        <button type="button" onClick={clearToday} className="w-full rounded-2xl bg-red-50 px-3 py-3 text-xs font-black text-red-700 transition hover:bg-red-100 active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300">
          Clear day
        </button>
      </div>
    </section>
  );
}

function CalendarPage({ command, onSelectDay, onSaveDay }) {
  const [anchor, setAnchor] = useState(command.today);
  const [selectedDate, setSelectedDate] = useState(command.today);
  const [blackoutMode, setBlackoutMode] = useState(false);
  const [savingBlackouts, setSavingBlackouts] = useState(() => new Set());
  const weekStartDay = Number(command.settings.default_week_start_day ?? 1);
  const normalWorkdays = command.settings.normal_workdays || [1, 2, 3, 4, 5, 6];
  const monthStartDate = monthStart(parseISO(anchor));
  const monthEndDate = monthEnd(parseISO(anchor));
  const gridStart = toISO(weekStart(monthStartDate, weekStartDay));
  const gridEnd = toISO(weekEnd(monthEndDate, weekStartDay));
  const monthKey = anchor.slice(0, 7);
  const daysByDate = Object.fromEntries(command.dayPlans.map((day) => [day.date, day]));
  const calendarDates = datesBetween(gridStart, gridEnd);
  const weekRows = [];
  for (let index = 0; index < calendarDates.length; index += 7) {
    weekRows.push(calendarDates.slice(index, index + 7));
  }
  const weekdayLabels = Array.from({ length: 7 }, (_, index) => {
    const value = (weekStartDay + index) % 7;
    return weekdayOptions.find((day) => day.value === value)?.label || "";
  });
  const claimedIncentivesByDate = useMemo(() => {
    return (command.incentives || []).reduce((dates, incentive) => {
      if (String(incentive.status || "").toLowerCase() !== "claimed") return dates;
      const date = incentiveCalendarDate(incentive);
      if (!date) return dates;
      dates[date] = (dates[date] || 0) + 1;
      return dates;
    }, {});
  }, [command.incentives]);

  function displayDay(date) {
    const existing = daysByDate[date];
    if (existing) return existing;
    const parsed = parseISO(date);
    const isNormalWorkday = parsed ? normalWorkdays.includes(parsed.getDay()) : true;
    return {
      date,
      actual: 0,
      dayType: isNormalWorkday ? "normal" : "off",
      capacity: isNormalWorkday ? 1 : 0,
      notes: "",
      include: isNormalWorkday,
      isToday: date === command.today,
      isPast: date < command.today,
      isFuture: date > command.today,
    };
  }

  function pickDay(date) {
    setSelectedDate(date);
    if (blackoutMode) {
      toggleBlackout(date, displayDay(date));
      return;
    }
    onSelectDay(date);
  }

  async function toggleBlackout(date, day) {
    if (!onSaveDay || savingBlackouts.has(date)) return;
    const entry = command.entriesByDate[date] || {};
    const isBlackout = day.dayType === "off" || day.dayType === "vacation" || day.dayType === "non_selling" || day.capacity <= 0 || day.include === false;
    const makeSelling = isBlackout;
    setSavingBlackouts((current) => new Set(current).add(date));
    try {
      await onSaveDay(date, {
        sales_count: day.actual ?? entry.sales_count ?? 0,
        sales_notes: entry.notes || "",
        day_type: makeSelling ? "normal" : "off",
        capacity_weight: makeSelling ? 1 : 0,
        planned_target: day.plannedTarget || 0,
        custom_target: day.customTarget ?? "",
        include_in_calculations: makeSelling,
        day_notes: day.notes || (makeSelling ? "" : "Blackout date."),
      });
    } finally {
      setSavingBlackouts((current) => {
        const next = new Set(current);
        next.delete(date);
        return next;
      });
    }
  }

  function weekGoalFor(week) {
    const start = week[0];
    const end = week[6];
    const match = command.weeks.find((item) => start <= item.week_end && end >= item.week_start);
    return Number(match?.weekly_goal || command.plan.default_weekly_goal || 0);
  }

  return (
    <div className="grid gap-4">
      <section className="glass-card rounded-3xl p-4">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setAnchor(toISO(addDays(monthStartDate, -1)))}
            className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700 transition hover:bg-slate-200 active:scale-[0.98]"
          >
            Prev
          </button>
          <div className="text-center">
            <div className="text-xs font-black uppercase tracking-wide text-indigo-600">Calendar</div>
            <h2 className="text-xl font-black text-slate-950">{formatMonth(anchor)}</h2>
          </div>
          <button
            type="button"
            onClick={() => setAnchor(toISO(addDays(monthEndDate, 1)))}
            className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700 transition hover:bg-slate-200 active:scale-[0.98]"
          >
            Next
          </button>
        </div>
        <button
          type="button"
          onClick={() => setAnchor(command.today)}
          className="mt-3 w-full rounded-2xl bg-indigo-50 px-4 py-2 text-sm font-black text-indigo-700 transition hover:bg-indigo-100 active:scale-[0.99]"
        >
          Jump to today
        </button>
        <button
          type="button"
          onClick={() => setBlackoutMode((value) => !value)}
          className={`mt-2 w-full rounded-2xl px-4 py-2 text-sm font-black transition active:scale-[0.99] ${
            blackoutMode ? "bg-slate-950 text-white hover:bg-slate-800" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          }`}
        >
          {blackoutMode ? "Done" : "Blackout Dates"}
        </button>
        {blackoutMode && (
          <div className="mt-2 rounded-2xl bg-slate-900 px-3 py-2 text-center text-xs font-bold text-white">
            Tap dates to mark vacation or non-selling days.
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
          {weekdayLabels.map((label) => (
            <div key={label} className="py-2 text-center text-[11px] font-black uppercase tracking-wide text-slate-400">
              {label}
            </div>
          ))}
        </div>
        <div className="grid gap-0">
          {weekRows.map((week) => {
            const weekTotal = week.reduce((sum, date) => sum + Number(displayDay(date).actual || 0), 0);
            const weekGoal = weekGoalFor(week);
            const weekProgress = weekGoal > 0 ? weekTotal / weekGoal : 0;
            const weekPercent = weekGoal > 0 ? Math.round(weekProgress * 100) : null;
            const achievement = weeklyAchievement(weekProgress, weekGoal);
            return (
              <div key={week[0]} className="border-b border-slate-100 last:border-0">
                <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-500">
                  <span>
                    Week: <span className="text-emerald-700">+{number(weekTotal)}</span>
                    {weekGoal > 0 && <span className="text-slate-400"> / {number(weekGoal)}</span>}
                    {weekPercent !== null && <span className="text-slate-400"> · {weekPercent}%</span>}
                  </span>
                  {achievement && <span className={`rounded-full px-2 py-0.5 text-[11px] ${achievement.className}`}>{achievement.label}</span>}
                </div>
                {weekGoal > 0 && weekTotal >= weekGoal && (
                  <div className="border-t border-yellow-100 bg-yellow-50 px-3 py-1 text-[11px] font-black text-yellow-800">
                    🥇 Goals Met
                  </div>
                )}
                <div className="grid grid-cols-7">
                  {week.map((date) => {
                    const day = displayDay(date);
                    const inMonth = date.slice(0, 7) === monthKey;
                    const selected = date === selectedDate;
                    const actual = Number(day.actual || 0);
                    const target = Number(day.plannedTarget || 0);
                    const outsideActiveRange = date < command.plan.start_date || date > command.plan.end_date;
                    const nonCountingCurrentMonth = inMonth && (outsideActiveRange || day.dayType === "off" || day.capacity <= 0 || day.include === false);
                    const outsideMonth = !inMonth;
                    const nonSelling = outsideMonth || nonCountingCurrentMonth;
                    const metGoal = !nonSelling && actual > 0 && target > 0 && actual >= target;
                    const strongDay = actual >= 4;
                    const claimedIncentives = claimedIncentivesByDate[date] || 0;
                    const savingBlackout = savingBlackouts.has(date);
                    return (
                      <button
                        key={date}
                        type="button"
                        onClick={() => pickDay(date)}
                        className={`min-h-[4.4rem] border-r border-slate-100 p-2 text-left transition last:border-r-0 hover:bg-indigo-50/60 active:scale-[0.98] ${
                          metGoal
                            ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                            : nonCountingCurrentMonth
                              ? "bg-slate-700 text-slate-100 hover:bg-slate-600"
                              : outsideMonth
                                ? "bg-slate-200/70 text-slate-400 hover:bg-slate-200"
                                : "bg-white"
                        } ${day.isToday ? "outline outline-2 outline-inset outline-indigo-400" : ""} ${selected ? "ring-2 ring-inset ring-indigo-500" : ""} ${savingBlackout ? "opacity-70" : ""}`}
                        aria-label={`${blackoutMode ? "Toggle blackout for" : "Edit"} ${formatDate(date)}`}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <span
                            className={`text-sm font-black ${
                              metGoal
                                ? "text-white"
                                : day.isToday
                                  ? "text-indigo-700"
                                  : outsideMonth
                                    ? "text-slate-400"
                                    : nonCountingCurrentMonth
                                      ? "text-slate-100"
                                      : "text-slate-800"
                            }`}
                          >
                            {parseISO(date).getDate()}
                          </span>
                          <span className="flex items-center gap-1">
                            {claimedIncentives > 0 && (
                              <span className="text-[10px] leading-none" aria-label={`${claimedIncentives} claimed incentive${claimedIncentives === 1 ? "" : "s"}`}>
                                🎁
                              </span>
                            )}
                            {nonCountingCurrentMonth && (
                              <span className="text-[10px] font-black leading-none text-slate-300" aria-label="Non-selling day">
                                x
                              </span>
                            )}
                          </span>
                        </div>
                        {actual > 0 && (
                          <div
                            className={`mt-2 inline-flex rounded-full px-2 py-0.5 font-black ${
                              metGoal
                                ? strongDay
                                  ? "bg-white/25 text-sm text-white shadow-sm"
                                  : "bg-white/20 text-xs text-white"
                                : nonSelling
                                ? strongDay
                                  ? "bg-slate-200 text-sm text-slate-700"
                                  : "bg-slate-200 text-xs text-slate-600"
                                : strongDay
                                  ? "bg-emerald-100 text-sm text-emerald-900 shadow-sm"
                                  : "bg-emerald-50 text-xs text-emerald-700"
                            }`}
                          >
                            +{number(actual)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function weeklyAchievement(progress, goal) {
  if (!goal || goal <= 0) return null;
  if (progress > 1) return { label: "Diamond", className: "bg-blue-100 text-blue-700" };
  if (progress >= 1) return { label: "🥇", className: "bg-yellow-100 text-yellow-800" };
  if (progress >= 0.75) return { label: "Silver", className: "bg-slate-200 text-slate-700" };
  if (progress < 0.6) return { label: "Bronze", className: "bg-stone-200 text-stone-700" };
  return null;
}

function incentiveCalendarDate(incentive) {
  return [incentive.claimed_at, incentive.target_date, incentive.updated_at]
    .map((value) => String(value || "").slice(0, 10))
    .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
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
  const [blockDrafts] = useState(() => blockDraftsFromDay(day));
  const [draft, setDraft] = useState({
    sales_count: day.actual ?? entry.sales_count ?? 0,
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

  function saveSimpleDay() {
    const desiredTotal = Math.max(0, Number(draft.sales_count || 0));
    const adjustedBlocks = reconcileBlocksToTotal(blockDrafts, desiredTotal);
    onSave({ ...draft, sales_count: desiredTotal, time_blocks: adjustedBlocks });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-slate-950/45 px-3 py-3 sm:place-items-center">
      <div className="max-h-[92vh] w-full max-w-md overflow-auto rounded-[2rem] bg-white p-5 shadow-glow">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-black uppercase tracking-wide text-indigo-600">Edit day</div>
            <h2 className="text-2xl font-black">{formatDate(day.date, { weekday: "long" })}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-2xl bg-slate-100 px-4 py-2 font-black transition active:scale-[0.98]">Cancel</button>
        </div>
        <div className="rounded-3xl bg-slate-50 p-4">
          <Field label="Total sales" type="number" value={draft.sales_count} onChange={(v) => setDraft({ ...draft, sales_count: v })} />
          <div className="mt-4">
            <Field
              label="Day status"
              type="select"
              value={draft.day_type}
              onChange={setDayType}
              options={Object.entries(dayTypes).map(([value, meta]) => ({ value, label: meta.label }))}
            />
          </div>
          <div className="mt-4">
            <Field label="Note" type="textarea" value={draft.sales_notes || draft.day_notes} onChange={(v) => setDraft({ ...draft, sales_notes: v, day_notes: v })} />
          </div>
          <Toggle label="Counts toward goal" checked={draft.include_in_calculations} onChange={(v) => setDraft({ ...draft, include_in_calculations: v })} />
        </div>
        {/* Future vacation/time-off ranges should use this same day status path so remaining selling days and the game plan recalculate cleanly. */}
        <button
          type="button"
          onClick={saveSimpleDay}
          className="mt-5 w-full rounded-2xl bg-slate-950 px-5 py-4 font-black text-white transition active:scale-[0.99]"
        >
          Save
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

function CompactMetric({ label, value, className = "", valueClassName = "" }) {
  return (
    <div className={`rounded-2xl bg-slate-50 px-3 py-3 transition-all duration-500 ${className}`}>
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-black transition-colors duration-500 ${valueClassName}`}>{value}</div>
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
    type_breakdown: normalizeSaleTypeBreakdown(block.type_breakdown, Number(block.actual || 0)),
    notes: block.notes || "",
    status: block.status,
    capacity_weight: block.capacity_weight,
    include_in_calculations: block.status !== "Skipped",
    isCurrent: block.isCurrent,
    minutesLeft: block.minutesLeft,
  }));
}

function reconcileBlocksToTotal(blocks, desiredTotal) {
  if (!blocks.length) return [];
  const sellingKeys = blocks.filter((block) => block.active && !block.is_break).map((block) => block.key);
  if (!sellingKeys.length) return blocks;
  let remainingReduction = Math.max(0, blocks.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0) - desiredTotal);
  let remainingAddition = Math.max(0, desiredTotal - blocks.reduce((sum, block) => sum + Number(block.actual_sales || 0), 0));
  const primaryKey = sellingKeys[0];
  return blocks.map((block) => {
    if (!sellingKeys.includes(block.key)) return block;
    let nextActual = Number(block.actual_sales || 0);
    if (remainingReduction > 0) {
      const reduction = Math.min(nextActual, remainingReduction);
      nextActual -= reduction;
      remainingReduction -= reduction;
    }
    if (block.key === primaryKey && remainingAddition > 0) {
      nextActual += remainingAddition;
      remainingAddition = 0;
    }
    return {
      ...block,
      actual_sales: nextActual,
      type_breakdown: resizeSaleTypeBreakdown(block.type_breakdown, nextActual),
    };
  });
}

function SaleTypeMiniStat({ icon: Icon, label, value, tone = "slate" }) {
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
      : tone === "indigo"
        ? "bg-indigo-50 text-indigo-700 ring-indigo-100"
        : "bg-white text-slate-700 ring-slate-200";
  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 ring-1 ${toneClass}`}>
      <Icon size={14} className="shrink-0 opacity-80" />
      <div className="min-w-0">
        <div className="truncate text-[11px] font-black uppercase tracking-wide opacity-60">{label}</div>
        <div className="text-sm font-black">{number(value)}</div>
      </div>
    </div>
  );
}

function LoadingScreen({ timedOut, onRetry, onSignOut }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-card">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600" />
        <h1 className="mt-4 text-xl font-black text-slate-900">Loading your command center...</h1>
        {timedOut && (
          <>
            <p className="mt-2 text-sm font-bold text-slate-500">Still loading. Something may be stuck, but you are not trapped here.</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={onRetry} className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white">
                Retry
              </button>
              <button type="button" onClick={onSignOut} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700">
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StartupError({ error, onRetry, onSignOut }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-card">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-red-50 text-red-600">
            <AlertTriangle size={22} />
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-950">Couldn’t load the app</h1>
            <p className="text-sm font-bold text-slate-500">The loader stopped safely instead of spinning forever.</p>
          </div>
        </div>
        <div className="mt-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button type="button" onClick={onRetry} className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white">
            Retry
          </button>
          <button type="button" onClick={onSignOut} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
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

function normalizeSaleTypeBreakdown(value, fallbackActual = 0) {
  const source = typeof value === "string" ? safeJsonParse(value) : value;
  const doors = Math.max(0, Number(source?.doors || 0));
  const phone = Math.max(0, Number(source?.phone || 0));
  if (doors + phone > 0) return { doors, phone };
  return { doors: Math.max(0, Number(fallbackActual || 0)), phone: 0 };
}

function resizeSaleTypeBreakdown(value, nextActual) {
  const breakdown = normalizeSaleTypeBreakdown(value, 0);
  const target = Math.max(0, Number(nextActual || 0));
  const current = breakdown.doors + breakdown.phone;
  if (target === 0) return { doors: 0, phone: 0 };
  if (current === 0) return { doors: target, phone: 0 };
  if (target >= current) return { doors: breakdown.doors + (target - current), phone: breakdown.phone };
  const doors = Math.min(breakdown.doors, target);
  return { doors, phone: Math.max(0, target - doors) };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function blockIcon(block) {
  const name = String(block?.name || "").toLowerCase();
  if (name.includes("morning")) return Sun;
  if (name.includes("afternoon")) return CloudSun;
  if (name.includes("evening")) return Moon;
  if (name.includes("push")) return Flame;
  return Clock;
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
