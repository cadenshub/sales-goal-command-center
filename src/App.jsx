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
  PlusCircle,
  Settings,
  Sparkles,
  Sun,
  Target,
  Trophy,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isSupabaseConfigured } from "./lib/supabase";
import {
  createWorkspace,
  deleteIncentive,
  deleteWeek,
  ensureProfile,
  getSession,
  loadCriticalWorkspace,
  loadOptionalWorkspace,
  onAuthChange,
  resetPlanStats,
  sendPasswordResetEmail,
  signIn,
  signOut,
  signUp,
  updatePlan,
  upsertCalendarDay,
  upsertIncentive,
  upsertSalesEntry,
  upsertSettings,
  upsertTimeBlockEntries,
  upsertWeeklyConfirmation,
  upsertWeek,
} from "./lib/repository";
import { buildCommandCenter, dayTypes, defaultTimeBlocks, getEffectiveWeeklyGoal, normalizeTimeBlocks } from "./lib/goalEngine";
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
const THEME_STORAGE_KEY = "sgcc-theme";

export default function App() {
  useAutoRefreshOnNewBuild();
  const [theme, setTheme] = useState(getInitialTheme);
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
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

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
      <aside className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white/95 px-2 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90 md:px-6 lg:bottom-auto lg:right-auto lg:top-0 lg:h-screen lg:w-72 lg:border-r lg:border-t-0 lg:px-5 lg:py-6">
        <div className="mb-8 hidden items-center gap-3 lg:flex">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-600 text-white shadow-glow">
            <Target size={24} />
          </div>
          <div>
            <div className="text-lg font-black">Sales Goal</div>
            <div className="text-sm font-semibold text-slate-500">Command Center</div>
          </div>
        </div>
        <nav className="mx-auto grid max-w-3xl grid-cols-6 gap-1 lg:mx-0 lg:max-w-none lg:grid-cols-1 lg:gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={`flex min-h-14 flex-col items-center justify-center rounded-2xl px-2 text-xs font-bold transition lg:min-h-11 lg:flex-row lg:justify-start lg:gap-3 lg:px-4 lg:text-sm ${
                  page === item.id
                    ? "bg-slate-950 text-white shadow-card dark:bg-slate-100 dark:text-slate-950"
                    : "text-slate-600 hover:bg-white hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white"
                }`}
              >
                <Icon size={19} />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden pt-8 lg:block">
          <div className="app-card">
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
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 px-4 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80 md:px-6 xl:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-500">{formatDate(command.today, { weekday: "long" })}</div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950 md:text-3xl">{workspace.plan.name}</h1>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle theme={theme} onToggle={() => setTheme((value) => (value === "dark" ? "light" : "dark"))} />
              <Badge tone={command.paceStatus.key}>{command.paceStatus.label}</Badge>
              <button
                type="button"
                onClick={() => setPage("goals")}
                className="app-primary-button px-4 py-3 text-sm"
              >
                Edit plan
              </button>
            </div>
          </div>
          {error && <div className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}
        </header>

        <div className="mx-auto max-w-7xl px-4 py-5 md:px-6 md:py-6 xl:px-8">
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
            />
          )}
          {page === "incentives" && (
            <IncentivesPage command={command} workspace={workspace} saveIncentive={saveIncentive} removeIncentive={removeIncentive} />
          )}
          {page === "settings" && (
            <SettingsPage
              user={session.user}
              workspace={workspace}
              saveSettings={saveSettings}
              savePlan={savePlan}
              onSendPasswordReset={sendResetPassword}
              onResetStats={resetStats}
            />
          )}
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

  async function sendResetPassword() {
    const email = session?.user?.email;
    if (!email) throw new Error("No email is available for this account.");
    await sendPasswordResetEmail(email, window.location.origin);
  }

  async function resetStats() {
    return saveAndPatch(
      (current) => ({
        ...current,
        salesEntries: [],
        timeBlockEntries: [],
      }),
      () => resetPlanStats(workspace.plan.id),
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

  async function saveIncentive(incentive) {
    const payload = normalizeIncentiveDraft(incentive, workspace.plan.id);
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
    incentives: [],
  });
  const [busy, setBusy] = useState(false);
  const [formErrors, setFormErrors] = useState([]);
  const steps = [
    { label: "Plan", description: "Name the season and set the date range." },
    { label: "Goals", description: "Set your sales targets and realistic pace." },
    { label: "Schedule", description: "Choose the days that count toward the plan." },
    { label: "Rewards", description: "Add optional incentives for milestones." },
    { label: "Review", description: "Check everything before creating the plan." },
  ];

  function updatePlanField(key, value) {
    setDraft((current) => ({ ...current, plan: { ...current.plan, [key]: value } }));
    setFormErrors([]);
  }

  function updateSettingsField(key, value) {
    setDraft((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
    setFormErrors([]);
  }

  function nextStep() {
    const errors = validateSetupStep(draft, step);
    if (errors.length) {
      setFormErrors(errors);
      return;
    }
    setFormErrors([]);
    setStep((current) => Math.min(steps.length - 1, current + 1));
  }

  async function finish() {
    if (busy) return;
    const result = normalizeSetupDraft(draft);
    if (result.errors.length) {
      setFormErrors(result.errors);
      setStep(result.step);
      return;
    }
    setBusy(true);
    setError("");
    setFormErrors([]);
    try {
      const workspace = await createWorkspace(user.id, result.payload);
      onCreated(workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4 py-6 md:px-6 md:py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-black uppercase tracking-wide text-indigo-600">First-time setup</div>
          <h1 className="text-3xl font-black tracking-tight text-slate-950 dark:text-slate-50 md:text-4xl">Build your command center</h1>
          <p className="mt-2 max-w-2xl text-sm font-bold text-slate-500">{steps[step].description}</p>
        </div>
      </div>

      <div className="mb-5 overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2">
          {steps.map((item, index) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setStep(index)}
              className={`rounded-2xl px-3 py-2 text-xs font-black transition ${
                index === step
                  ? "bg-slate-950 text-white shadow-card"
                  : index < step
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
              }`}
            >
              {index < step ? "Done" : index + 1}. {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mb-5 rounded-2xl bg-red-50 p-4 font-bold text-red-700">{error}</div>}
      {formErrors.length > 0 && (
        <div className="mb-5 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700">
          {formErrors.map((item) => (
            <div key={item}>{item}</div>
          ))}
        </div>
      )}

      <div className="glass-card rounded-[2rem] p-5 md:p-7 lg:p-8">
        {step === 0 && (
          <SetupStep title="Plan" icon={Target}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Plan name" value={draft.plan.name} onChange={(v) => updatePlanField("name", v)} />
              <Field label="Season start" type="date" value={draft.plan.start_date} onChange={(v) => updatePlanField("start_date", v)} />
              <Field label="Season end" type="date" value={draft.plan.end_date} onChange={(v) => updatePlanField("end_date", v)} />
              <Field label="Tracking start" type="date" value={draft.plan.tracking_start_date} onChange={(v) => updatePlanField("tracking_start_date", v)} />
            </div>
            <Toggle
              label="Count sales outside the active date range"
              checked={draft.plan.include_outside_range_sales}
              onChange={(v) => updatePlanField("include_outside_range_sales", v)}
            />
          </SetupStep>
        )}
        {step === 1 && (
          <SetupStep title="Goals" icon={BarChart3}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Season goal" type="number" value={draft.plan.total_goal} onChange={(v) => updatePlanField("total_goal", v)} />
              <Field label="Weekly goal" type="number" value={draft.plan.default_weekly_goal} onChange={(v) => updatePlanField("default_weekly_goal", v)} />
              <Field label="Starting sales" type="number" value={draft.plan.starting_sales} onChange={(v) => updatePlanField("starting_sales", v)} />
              <Field label="Max sales per day" type="number" value={draft.plan.max_sales_per_day} onChange={(v) => updatePlanField("max_sales_per_day", v)} />
            </div>
            <Field
              label="Catch-up style"
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
          </SetupStep>
        )}
        {step === 2 && (
          <SetupStep title="Schedule" icon={Calendar}>
            <WeekdayPicker
              value={draft.settings.normal_workdays}
              onChange={(normal_workdays) => updateSettingsField("normal_workdays", normal_workdays)}
            />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Field label="Week starts on" type="select" value={draft.settings.default_week_start_day} onChange={(v) => updateSettingsField("default_week_start_day", Number(v))} options={weekdayOptions} />
            </div>
            <SetupBlackoutCalendar
              plan={draft.plan}
              settings={draft.settings}
              calendarDays={draft.calendarDays}
              onToggleDate={(date) =>
                setDraft((current) => ({
                  ...current,
                  calendarDays: toggleSetupBlackoutDate(current.calendarDays, date),
                }))
              }
            />
            <EditableList
              items={draft.calendarDays}
              empty="Blackout dates and custom schedule days will appear here."
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
          </SetupStep>
        )}
        {step === 3 && (
          <SetupStep title="Rewards" icon={Gift}>
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  incentives: [
                    ...current.incentives,
                    {
                      setupId: crypto.randomUUID(),
                      title: "",
                      description: "",
                      incentive_type: "sales_milestone",
                      target_value: "",
                      target_date: "",
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
              empty="Rewards are optional. Add one if it helps make the goal more fun."
              render={(incentive, index) => (
                <SetupRewardEditor
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
          </SetupStep>
        )}
        {step === 4 && (
          <SetupStep title="Review" icon={CheckCircle2}>
            <div className="grid gap-3 md:grid-cols-2">
              <ReviewItem label="Plan" value={draft.plan.name || "Missing name"} />
              <ReviewItem label="Season" value={`${draft.plan.start_date || "Start"} to ${draft.plan.end_date || "End"}`} />
              <ReviewItem label="Season goal" value={`${draft.plan.total_goal || 0} sales`} />
              <ReviewItem label="Weekly goal" value={`${draft.plan.default_weekly_goal || 0} sales`} />
              <ReviewItem label="Workdays" value={`${draft.settings.normal_workdays.length} days selected`} />
              <ReviewItem label="Blackout dates" value={`${countSetupBlackouts(draft.calendarDays)} selected`} />
              <ReviewItem label="Rewards" value={`${draft.incentives.filter((item) => String(item.title || "").trim()).length} added`} />
            </div>
          </SetupStep>
        )}
      </div>
      <div className="sticky bottom-0 mt-6 flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/90 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <button
          type="button"
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0 || busy}
          className="rounded-2xl border border-slate-200 px-5 py-3 font-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>
        {step < steps.length - 1 ? (
          <button type="button" onClick={nextStep} className="rounded-2xl bg-slate-950 px-5 py-3 font-black text-white">
            Next
          </button>
        ) : (
          <button type="button" onClick={finish} className="rounded-2xl bg-emerald-600 px-5 py-3 font-black text-white" disabled={busy}>
            {busy ? "Creating plan..." : "Finish Setup"}
          </button>
        )}
      </div>
    </div>
  );
}

function SetupStep({ title, icon: Icon, children }) {
  return (
    <section>
      <div className="mb-5 flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-950 text-white">
          <Icon size={20} />
        </div>
        <h2 className="text-2xl font-black text-slate-950 dark:text-slate-50">{title}</h2>
      </div>
      <div className="grid gap-5">{children}</div>
    </section>
  );
}

function ReviewItem({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-950">
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 font-black text-slate-950 dark:text-slate-50">{value}</div>
    </div>
  );
}

function SetupBlackoutCalendar({ plan, settings, calendarDays, onToggleDate }) {
  const [anchor, setAnchor] = useState(plan.start_date || todayISO());
  useEffect(() => {
    if (plan.start_date) setAnchor(plan.start_date);
  }, [plan.start_date]);
  const weekStartDay = Number(settings.default_week_start_day ?? 1);
  const normalWorkdays = settings.normal_workdays || [1, 2, 3, 4, 5, 6];
  const monthStartDate = monthStart(parseISO(anchor));
  const monthEndDate = monthEnd(parseISO(anchor));
  const gridStart = toISO(weekStart(monthStartDate, weekStartDay));
  const gridEnd = toISO(weekEnd(monthEndDate, weekStartDay));
  const monthKey = anchor.slice(0, 7);
  const calendarDates = datesBetween(gridStart, gridEnd);
  const dayOverrides = Object.fromEntries(calendarDays.map((day) => [day.date, day]));
  const weekdayLabels = Array.from({ length: 7 }, (_, index) => {
    const value = (weekStartDay + index) % 7;
    return weekdayOptions.find((day) => day.value === value)?.label || "";
  });

  return (
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-card dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setAnchor(toISO(addDays(monthStartDate, -1)))}
          className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700 transition active:scale-[0.98] dark:bg-slate-800 dark:text-slate-100"
        >
          Prev
        </button>
        <div className="text-center">
          <div className="text-xs font-black uppercase tracking-wide text-slate-400">Blackout dates</div>
          <div className="text-lg font-black text-slate-950 dark:text-slate-50">{formatMonth(anchor)}</div>
        </div>
        <button
          type="button"
          onClick={() => setAnchor(toISO(addDays(monthEndDate, 1)))}
          className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700 transition active:scale-[0.98] dark:bg-slate-800 dark:text-slate-100"
        >
          Next
        </button>
      </div>
      <div className="mb-3 rounded-2xl bg-slate-950 px-3 py-2 text-center text-xs font-bold text-white">
        Tap dates to mark vacation or non-selling days.
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700">
        <div className="grid grid-cols-7 bg-slate-50 dark:bg-slate-950">
          {weekdayLabels.map((label) => (
            <div key={label} className="py-2 text-center text-[10px] font-black uppercase tracking-wide text-slate-400">
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {calendarDates.map((date) => {
            const parsed = parseISO(date);
            const inMonth = date.slice(0, 7) === monthKey;
            const outsideRange = Boolean((plan.start_date && date < plan.start_date) || (plan.end_date && date > plan.end_date));
            const isNormalWorkday = parsed ? normalWorkdays.includes(parsed.getDay()) : true;
            const override = dayOverrides[date];
            const blackout = isSetupBlackoutDay(override);
            const nonWorkday = !isNormalWorkday || outsideRange;
            return (
              <button
                key={date}
                type="button"
                onClick={() => !outsideRange && onToggleDate(date)}
                disabled={outsideRange}
                className={`min-h-12 border-r border-t border-slate-200 p-1.5 text-left text-sm font-black transition last:border-r-0 active:scale-[0.98] dark:border-slate-700 md:min-h-14 md:p-2 ${
                  blackout
                    ? "bg-slate-700 text-white hover:bg-slate-600"
                    : !inMonth
                      ? "bg-slate-200/70 text-slate-400 dark:bg-slate-800/80 dark:text-slate-500"
                      : nonWorkday
                        ? "bg-slate-100 text-slate-400 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-500"
                        : "bg-white text-slate-800 hover:bg-indigo-50 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                } ${outsideRange ? "cursor-not-allowed opacity-50" : ""}`}
                aria-label={`${blackout ? "Unmark" : "Mark"} ${formatDate(date)} as a blackout date`}
              >
                <span>{parsed?.getDate()}</span>
                {blackout && <span className="float-right text-[10px] text-white">x</span>}
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-3 text-xs font-bold text-slate-500">
        Blackout days will not count toward your selling schedule.
      </p>
    </section>
  );
}

function SetupRewardEditor({ incentive, onChange, onDelete }) {
  const [more, setMore] = useState(Boolean(incentive.description || incentive.reward_value || incentive.target_date));
  return (
    <div className="rounded-3xl border border-purple-100 bg-white p-4 shadow-card dark:border-purple-900/60 dark:bg-slate-900 md:p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-200">
            <Gift size={20} />
          </div>
          <div>
            <div className="text-xs font-black uppercase tracking-wide text-purple-600">Reward</div>
            <div className="text-lg font-black text-slate-950 dark:text-slate-50">
              {String(incentive.title || "").trim() || "New reward"}
            </div>
          </div>
        </div>
        <button type="button" onClick={onDelete} className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-black text-red-700 transition active:scale-[0.98]">
          Delete
        </button>
      </div>
      <div className="grid gap-4">
        <Field label="Reward name" value={incentive.title} onChange={(v) => onChange({ ...incentive, title: v })} />
        <Field
          label="Reward type"
          type="select"
          value={incentive.incentive_type}
          onChange={(v) => onChange({ ...incentive, incentive_type: v })}
          options={[
            { value: "sales_milestone", label: "Sales milestone" },
            { value: "weekly_goal", label: "Weekly goal" },
            { value: "streak", label: "Streak" },
            { value: "season_goal", label: "Season goal" },
            { value: "custom", label: "Custom" },
          ]}
        />
        <Field label="Goal number" type="text" value={incentive.target_value} onChange={(v) => onChange({ ...incentive, target_value: v })} />
      </div>
      <button type="button" onClick={() => setMore((value) => !value)} className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 transition active:scale-[0.98] dark:bg-slate-800 dark:text-slate-200">
        {more ? "Hide more options" : "More options"}
      </button>
      {more && (
        <div className="mt-4 grid gap-4 rounded-3xl bg-purple-50/70 p-4 dark:bg-purple-950/20">
          <Field label="Reward value" type="text" value={incentive.reward_value ?? ""} onChange={(v) => onChange({ ...incentive, reward_value: v })} />
          <Field label="Target date" type="date" value={incentive.target_date || ""} onChange={(v) => onChange({ ...incentive, target_date: v })} />
          <Field label="Description" type="textarea" value={incentive.description || ""} onChange={(v) => onChange({ ...incentive, description: v })} />
        </div>
      )}
    </div>
  );
}

function validateSetupStep(draft, step) {
  const errors = [];
  if (step === 0) {
    if (!String(draft.plan.name || "").trim()) errors.push("Plan name is required.");
    if (!draft.plan.start_date || !draft.plan.end_date) errors.push("Season start and end dates are required.");
    if (draft.plan.start_date && draft.plan.end_date && draft.plan.end_date < draft.plan.start_date) errors.push("Season end date must be after the start date.");
  }
  if (step === 1) {
    requirePositiveNumber(errors, draft.plan.total_goal, "Season goal");
    requirePositiveNumber(errors, draft.plan.default_weekly_goal, "Weekly goal");
    requirePositiveNumber(errors, draft.plan.max_sales_per_day, "Max sales per day");
    optionalNonNegativeNumber(errors, draft.plan.starting_sales, "Starting sales");
  }
  if (step === 2 && !draft.settings.normal_workdays.length) errors.push("Choose at least one normal workday.");
  if (step === 3) normalizeSetupRewards(draft.incentives).errors.forEach((item) => errors.push(item));
  return errors;
}

function normalizeSetupDraft(draft) {
  const stepErrors = [0, 1, 2, 3].map((index) => validateSetupStep(draft, index));
  const errors = stepErrors.flat();
  if (errors.length) {
    const step = stepErrors.findIndex((items) => items.length);
    return { errors, step, payload: null };
  }
  const plan = {
    ...draft.plan,
    name: String(draft.plan.name || "").trim(),
    tracking_start_date: draft.plan.tracking_start_date || draft.plan.start_date,
    total_goal: requiredNumber(draft.plan.total_goal),
    starting_sales: optionalNumber(draft.plan.starting_sales) ?? 0,
    default_weekly_goal: requiredNumber(draft.plan.default_weekly_goal),
    max_sales_per_day: requiredNumber(draft.plan.max_sales_per_day),
  };
  const incentives = normalizeSetupRewards(draft.incentives).rewards;
  return {
    errors: [],
    step: 4,
    payload: {
      ...draft,
      plan,
      weeks: [],
      goalPeriods: [],
      incentives,
      calendarDays: normalizeSetupCalendarDays(draft.calendarDays),
    },
  };
}

function toggleSetupBlackoutDate(calendarDays, date) {
  const existing = calendarDays.find((day) => day.date === date);
  if (isSetupBlackoutDay(existing)) return calendarDays.filter((day) => day.date !== date);
  const blackoutDay = {
    date,
    day_type: "off",
    capacity_weight: 0,
    planned_target: 0,
    custom_target: null,
    include_in_calculations: false,
    notes: "Blackout date.",
  };
  return [...calendarDays.filter((day) => day.date !== date), blackoutDay].sort((a, b) => a.date.localeCompare(b.date));
}

function isSetupBlackoutDay(day) {
  if (!day) return false;
  return day.day_type === "off" || day.day_type === "vacation" || day.day_type === "non_selling" || Number(day.capacity_weight ?? 1) <= 0 || day.include_in_calculations === false;
}

function countSetupBlackouts(calendarDays) {
  return calendarDays.filter(isSetupBlackoutDay).length;
}

function normalizeSetupCalendarDays(calendarDays) {
  const daysByDate = new Map();
  calendarDays.forEach((day) => {
    if (!day.date) return;
    const safeDay = { ...day };
    delete safeDay.setupId;
    daysByDate.set(day.date, {
      ...safeDay,
      capacity_weight: optionalNumber(day.capacity_weight) ?? 0,
      planned_target: optionalNumber(day.planned_target) ?? 0,
      custom_target: optionalNumber(day.custom_target),
      include_in_calculations: day.include_in_calculations !== false,
      notes: String(day.notes || "").trim(),
    });
  });
  return [...daysByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeSetupRewards(incentives) {
  const errors = [];
  const rewards = [];
  incentives.forEach((item, index) => {
    const title = String(item.title || "").trim();
    const targetBlank = isBlank(item.target_value);
    const hasAnyValue = title || !targetBlank || String(item.description || "").trim() || !isBlank(item.reward_value) || item.target_date;
    if (!hasAnyValue) return;
    const beforeErrorCount = errors.length;
    if (!title) errors.push(`Reward ${index + 1}: reward name is required.`);
    if (targetBlank) errors.push(`Reward ${index + 1}: reward goal is required.`);
    if (!targetBlank) requirePositiveNumber(errors, item.target_value, `Reward ${index + 1} goal`);
    if (!isBlank(item.reward_value)) optionalNonNegativeNumber(errors, item.reward_value, `Reward ${index + 1} value`);
    if (errors.length > beforeErrorCount) return;
    rewards.push({
      title,
      description: String(item.description || "").trim(),
      incentive_type: item.incentive_type || "sales_milestone",
      target_value: requiredNumber(item.target_value),
      target_date: item.target_date || null,
      related_goal_period_id: item.related_goal_period_id || null,
      reward_value: optionalNumber(item.reward_value),
      status: item.status || "locked",
    });
  });
  return { errors, rewards };
}

function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

function requiredNumber(value) {
  return parseNumericInput(value);
}

function optionalNumber(value) {
  return isBlank(value) ? null : parseNumericInput(value);
}

function requirePositiveNumber(errors, value, label) {
  const number = parseNumericInput(value);
  if (number === null || !Number.isFinite(number) || number <= 0) errors.push(`${label} must be greater than 0.`);
}

function optionalNonNegativeNumber(errors, value, label) {
  const number = parseNumericInput(value);
  if (!isBlank(value) && (!Number.isFinite(number) || number < 0)) errors.push(`${label} must be 0 or higher.`);
}

function parseNumericInput(value) {
  if (isBlank(value)) return null;
  const normalized = String(value).trim().replace(/[$,\s]/g, "");
  if (!normalized) return null;
  return Number(normalized);
}

function Dashboard({ command, setPage, onSaveDay }) {
  const completion = command.plan.total_goal > 0 ? (command.completed / command.plan.total_goal) * 100 : 0;
  return (
    <div className="mx-auto grid max-w-6xl gap-4 md:gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)] xl:items-start">
      <TodaySalesCard command={command} onSaveDay={onSaveDay} />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
        <CoachSummary command={command} setPage={setPage} />
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
        <RewardSummary command={command} setPage={setPage} />
      </section>
    </div>
  );
}

function CoachSummary({ command, setPage }) {
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
    <section className="rounded-[1.5rem] border border-indigo-100 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900 md:p-4">
      <div className="flex items-start gap-2.5">
        <div className="app-icon h-8 w-8 rounded-xl">
          <Sparkles size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-black uppercase tracking-wide text-slate-400">Coach</div>
          <p className="mt-1 text-sm font-black leading-5 text-slate-950 dark:text-slate-50">{message}</p>
          <button
            type="button"
            onClick={() => setPage("goals")}
            className="mt-2 inline-flex rounded-full bg-slate-950 px-3 py-1.5 text-xs font-black text-white transition hover:bg-slate-800 active:scale-[0.98] dark:bg-slate-50 dark:text-slate-950"
          >
            Goals
          </button>
        </div>
      </div>
    </section>
  );
}

function RewardSummary({ command, setPage }) {
  return (
    <IncentivePanel title="Next reward" icon={Gift}>
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
          <button type="button" onClick={() => setPage("incentives")} className="rounded-2xl bg-purple-600 px-4 py-3 font-black text-white transition hover:bg-purple-700 active:scale-[0.98]">
            Add reward
          </button>
        </div>
      )}
    </IncentivePanel>
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
  const [addSalesOpen, setAddSalesOpen] = useState(true);
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
    setAddSalesOpen(true);
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
    <section className="relative overflow-hidden rounded-[2rem] border border-indigo-100 bg-white p-4 shadow-card dark:border-slate-700 dark:bg-slate-900 md:p-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-indigo-500 via-emerald-400 to-indigo-500" />
      <div className="flex items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <div className="text-xs font-black uppercase tracking-wide text-indigo-600">Sales for today</div>
          <h2 className="mt-1 truncate text-xl font-black tracking-tight text-slate-950 dark:text-slate-50">
            {formatDate(today.date, { weekday: "short", month: "short", day: "numeric" })}
          </h2>
        </div>
        <div className="shrink-0 scale-90 opacity-70">
          <Badge tone={statusTone(today.status)}>{today.status}</Badge>
        </div>
      </div>

      <div className="mt-4 rounded-[1.75rem] border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-emerald-50 p-4 shadow-sm dark:border-slate-700 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-black uppercase tracking-wide text-slate-400">Done today</div>
            <div className="mt-1 flex flex-wrap items-end gap-x-2 gap-y-1">
              <span className={`text-5xl font-black leading-none tracking-tight text-slate-950 transition-colors duration-500 dark:text-slate-50 ${donePulse ? "text-emerald-600 drop-shadow-sm dark:text-emerald-400" : ""}`}>
                {number(totalActual)}
              </span>
              <span className="pb-1 text-lg font-black text-slate-400">of {number(totalTarget, 1)}</span>
            </div>
          </div>
          <div className="shrink-0 rounded-2xl bg-white px-3 py-2 text-right shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
            <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Goal</div>
            <div className="text-lg font-black text-slate-950 dark:text-slate-50">{number(totalTarget, 1)}</div>
          </div>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-500" style={{ width: `${Math.min(100, dailyProgress)}%` }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{dayHelpText}</p>
          <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-slate-500 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
            {today.dayType === "off" ? "Bonus" : remaining <= 0 ? "Covered" : `${number(remaining, 1)} left`}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setAddSalesOpen((value) => !value)}
        className={
          addSalesOpen
            ? "mt-4 inline-flex min-h-10 items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-black text-white transition hover:bg-slate-800 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 dark:bg-slate-50 dark:text-slate-950"
            : "mt-4 flex min-h-16 w-full items-center justify-center gap-2 rounded-[1.5rem] bg-gradient-to-r from-indigo-600 to-emerald-600 px-5 py-4 text-base font-black text-white shadow-lg shadow-indigo-200/60 transition hover:from-indigo-700 hover:to-emerald-700 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:shadow-none sm:max-w-sm"
        }
      >
        {!addSalesOpen && <PlusCircle size={20} />}
        {addSalesOpen ? "Close" : "Add Sales"}
      </button>

      <div className={`${addSalesOpen ? "mt-3" : "mt-0"} rounded-[1.75rem] ${addSalesOpen ? "border-2 border-indigo-100 bg-indigo-50/60 p-2 dark:border-slate-700 dark:bg-slate-950" : ""}`}>
        {addSalesOpen && (
          <div className="rounded-[1.35rem] bg-white p-3 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-sm font-black uppercase tracking-wide text-indigo-600">Log sales</div>
              <div className="text-xs font-bold text-slate-400">{selectedBlock?.name || "Choose block"}</div>
            </div>
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
                      selected ? "bg-slate-950 text-white shadow-card dark:bg-slate-50 dark:text-slate-950" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
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
                      selected ? "bg-indigo-600 text-white shadow-card ring-2 ring-indigo-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
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
                    Number(logAmount) === amount ? "bg-emerald-600 text-white shadow-card ring-2 ring-emerald-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
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
                className="min-h-11 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-center font-black outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50"
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setShowAllBlocks((value) => !value)}
          className="inline-flex min-h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-600 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {showAllBlocks ? "Hide full day" : "View full day"}
        </button>
        <button type="button" onClick={clearToday} className="text-xs font-black text-red-500 underline-offset-4 transition hover:text-red-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300">
          Clear day
        </button>
      </div>

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
    const match =
      command.weeks.find((item) => item.week_start === start && item.week_end === end) ||
      command.weeks.find((item) => item.week_start <= start && end <= item.week_end);
    return getEffectiveWeeklyGoal(match, command.plan);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4 md:gap-5">
      <section className="glass-card rounded-3xl p-4 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setAnchor(toISO(addDays(monthStartDate, -1)))}
            className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700 transition hover:bg-slate-200 active:scale-[0.98] dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          >
            Prev
          </button>
          <div className="text-center">
            <div className="text-xs font-black uppercase tracking-wide text-indigo-600">Calendar</div>
            <h2 className="text-xl font-black text-slate-950 dark:text-slate-50">{formatMonth(anchor)}</h2>
          </div>
          <button
            type="button"
            onClick={() => setAnchor(toISO(addDays(monthEndDate, 1)))}
            className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700 transition hover:bg-slate-200 active:scale-[0.98] dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          >
            Next
          </button>
        </div>
        <button
          type="button"
          onClick={() => setAnchor(command.today)}
          className="mt-3 w-full rounded-2xl bg-indigo-50 px-4 py-2 text-sm font-black text-indigo-700 transition hover:bg-indigo-100 active:scale-[0.99] dark:bg-indigo-950/70 dark:text-indigo-200 dark:hover:bg-indigo-900"
        >
          Jump to today
        </button>
        <button
          type="button"
          onClick={() => setBlackoutMode((value) => !value)}
          className={`mt-2 w-full rounded-2xl px-4 py-2 text-sm font-black transition active:scale-[0.99] ${
            blackoutMode ? "bg-slate-950 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-950" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
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

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card dark:border-slate-700 dark:bg-slate-900">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
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
              <div key={week[0]} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                  <span>
                    Week: <span className="text-emerald-700">+{number(weekTotal)}</span>
                    {weekGoal > 0 && <span className="text-slate-400"> / {number(weekGoal)}</span>}
                    {weekPercent !== null && <span className="text-slate-400"> · {weekPercent}%</span>}
                  </span>
                  {achievement && <span className={`rounded-full px-2 py-0.5 text-[11px] ${achievement.className}`}>{achievement.label}</span>}
                </div>
                {weekGoal > 0 && weekTotal >= weekGoal && (
                  <div className="border-t border-yellow-500/50 bg-yellow-300 px-3 py-1 text-[11px] font-black text-yellow-950 shadow-inner dark:border-yellow-300/40 dark:bg-yellow-400 dark:text-yellow-950">
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
                        className={`min-h-[4.4rem] border-r border-slate-200 p-2 text-left transition last:border-r-0 hover:bg-indigo-50/60 active:scale-[0.98] dark:border-slate-700 md:min-h-[5.6rem] md:p-3 ${
                          metGoal
                            ? "border-emerald-400 bg-emerald-500 text-white shadow-inner hover:bg-emerald-600 dark:border-emerald-300 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                            : nonCountingCurrentMonth
                              ? "bg-slate-600 text-slate-50 hover:bg-slate-500 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
                              : outsideMonth
                                ? "bg-slate-200/70 text-slate-400 hover:bg-slate-200 dark:bg-slate-800/70 dark:text-slate-500 dark:hover:bg-slate-800"
                                : "bg-white hover:bg-indigo-50/60 dark:bg-slate-900 dark:hover:bg-slate-800"
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
                              <span
                                className="inline-grid h-4 w-4 place-items-center rounded-full bg-purple-600 text-[10px] leading-none shadow-sm ring-1 ring-purple-200 dark:bg-purple-400 dark:ring-purple-200"
                                aria-label={`${claimedIncentives} claimed incentive${claimedIncentives === 1 ? "" : "s"}`}
                              >
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
  if (progress <= 0) return null;
  if (progress > 1) return { label: "Diamond", className: "bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-400/20 dark:text-cyan-100 dark:ring-cyan-300/30" };
  if (progress >= 1) return { label: "Gold", className: "bg-yellow-200 text-yellow-900 ring-1 ring-yellow-400/60 dark:bg-yellow-300 dark:text-yellow-950 dark:ring-yellow-100/40" };
  if (progress >= 0.75) return { label: "Silver", className: "bg-slate-200 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-300 dark:text-slate-900 dark:ring-slate-100/40" };
  if (progress < 0.6) return { label: "Bronze", className: "bg-[#ead2b8] text-[#7a461c] ring-1 ring-[#b87333]/40 dark:bg-[#8a5529] dark:text-[#ffe3c2] dark:ring-[#d69a5b]/40" };
  return null;
}

function incentiveCalendarDate(incentive) {
  return [incentive.claimed_at, incentive.target_date, incentive.updated_at]
    .map((value) => String(value || "").slice(0, 10))
    .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getInitialTheme() {
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeToggle({ theme, onToggle }) {
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="grid h-11 w-11 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-card transition hover:-translate-y-0.5 hover:border-indigo-200 hover:text-indigo-700 active:scale-[0.98] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-indigo-400"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      <Icon size={18} />
    </button>
  );
}

function WeeklyPlanner({ command, saveWeek, removeWeek, saveDay }) {
  const indexedWeeks = command.weeks.map((week, index) => ({ ...week, seasonWeekNumber: index + 1 }));
  const currentWeek =
    indexedWeeks.find((week) => week.week_start === command.currentWeek.week_start && week.week_end === command.currentWeek.week_end) ||
    { ...command.currentWeek, seasonWeekNumber: Math.max(1, indexedWeeks.findIndex((week) => week.week_start <= command.today && week.week_end >= command.today) + 1) };
  const currentWeekIndex = Math.max(0, indexedWeeks.findIndex((week) => week.week_start === currentWeek.week_start && week.week_end === currentWeek.week_end));
  const visibleWeeks = indexedWeeks.slice(Math.max(0, currentWeekIndex - 4), Math.min(indexedWeeks.length, currentWeekIndex + 5));
  const [showWeekEditor, setShowWeekEditor] = useState(false);
  const stats = statsPageSummary(command, currentWeek);
  return (
    <div className="mx-auto grid max-w-6xl gap-4 md:gap-5">
      <PageIntro
        eyebrow="Week Planner"
        title="Weekly progress"
        description="See this week, the recent trend, and the next few goals coming up."
      />
      <CurrentWeekSummary week={currentWeek} command={command} />
      <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr] lg:items-stretch">
        <StatsTotals stats={stats} />
        <WeeklyOverviewGraph weeks={visibleWeeks} />
      </section>
      <WeeklyOverviewList weeks={visibleWeeks} />
      <Card title="Week goals" icon={Edit3} compact>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-bold text-slate-500">Week editing is tucked away for now so the stats stay easy to scan.</p>
          <button
            type="button"
            onClick={() => setShowWeekEditor((value) => !value)}
            className="app-primary-button px-4 py-3 text-sm"
          >
            {showWeekEditor ? "Hide week goals" : "Edit week goals"}
          </button>
        </div>
        {showWeekEditor && (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {command.weeks.map((week) => (
              <WeekCard key={`${week.week_start}-${week.week_end}-${week.id || ""}`} week={week} command={command} saveWeek={saveWeek} removeWeek={removeWeek} saveDay={saveDay} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function CurrentWeekSummary({ week, command }) {
  const progress = Number(week.progress || 0);
  const remaining = Math.max(0, Number(week.weekly_goal || 0) - Number(week.actual || 0));
  const message =
    remaining <= 0
      ? "Goal met. Everything else is bonus."
      : command.requiredThisWeek > command.plan.max_sales_per_day
        ? `${number(remaining, 1)} left. This week is above your max daily pace.`
        : `${number(remaining, 1)} sales left this week.`;
  return (
    <Card title={`Week ${week.seasonWeekNumber || ""}`} icon={Calendar} compact>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm font-bold text-slate-500">{formatRange(week.week_start, week.week_end)}</div>
          <div className="mt-1 text-3xl font-black text-slate-950 dark:text-slate-50">
            {number(week.actual)} / {number(week.weekly_goal)}
          </div>
          <div className="mt-1 text-sm font-bold text-slate-500">{message}</div>
        </div>
        <Badge tone={remaining <= 0 ? "ahead" : command.requiredThisWeek > command.plan.max_sales_per_day ? "critical" : "on_track"}>
          {remaining <= 0 ? "Goal met" : "Active"}
        </Badge>
      </div>
      <Progress value={progress} />
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <MiniMetric label="Days left" value={number(week.remainingCapacity, 1)} />
        <MiniMetric label="Needed / day" value={number(week.requiredPerDay, 1)} />
      </div>
    </Card>
  );
}

function StatsTotals({ stats }) {
  return (
    <Card title="Sales Stats" icon={BarChart3}>
      <div className="grid gap-3 sm:grid-cols-2">
        <StatTile label="Week Total" value={`${number(stats.week.actual)} / ${number(stats.week.goal)}`} detail={`${number(stats.week.progress, 0)}% of goal`} />
        <StatTile label="Month Total" value={number(stats.month.actual)} detail={stats.month.goal ? `${number(stats.month.goal)} monthly goal` : "Current month sales"} />
        <StatTile label="Season Total" value={`${number(stats.season.actual)} / ${number(stats.season.goal)}`} detail={`${number(stats.season.progress, 0)}% complete`} />
        <StatTile label="Incentives Met" value={`${number(stats.incentives.met)} / ${number(stats.incentives.total)}`} detail="Achieved or claimed" />
      </div>
    </Card>
  );
}

function WeeklyOverviewGraph({ weeks }) {
  const data = weeklyGraphData(weeks);
  const hasData = data.some((item) => item.actual > 0 || item.goal > 0);
  return (
    <Card title="Weekly Actual vs Goal" icon={TrendingUp}>
      {!hasData ? (
        <div className="rounded-3xl bg-slate-50 p-5 text-sm font-bold text-slate-500 dark:bg-slate-950">
          Log more sales to see your weekly trend.
        </div>
      ) : (
        <div className="h-56 sm:h-64 lg:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="actual" name="Actual" fill="#10b981" radius={[8, 8, 0, 0]} />
              <Line type="monotone" dataKey="goal" name="Goal" stroke="#6366f1" strokeWidth={3} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function WeeklyOverviewList({ weeks }) {
  return (
    <Card title="Weekly overview" icon={Calendar} compact>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {weeks.map((week) => {
          const progress = Number(week.progress || 0);
          const badge = weeklyAchievement(progress / 100, week.weekly_goal);
          const isFuture = week.week_start > todayISO();
          return (
            <div
              key={`${week.week_start}-${week.week_end}-${week.id || ""}`}
              className={`rounded-2xl border p-3 shadow-sm dark:bg-slate-900 ${weeklyOverviewCardClass(badge?.label, isFuture)}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-black uppercase tracking-wide text-indigo-600">Week {week.seasonWeekNumber}</div>
                  <div className="mt-1 truncate text-sm font-black text-slate-950 dark:text-slate-50">{formatRange(week.week_start, week.week_end)}</div>
                  <div className="mt-1 text-xs font-bold text-slate-500">
                    {number(week.actual)} / {number(week.weekly_goal)} sales
                  </div>
                </div>
                {badge && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black ${badge.className}`}>{badge.label}</span>}
              </div>
              <Progress value={progress} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function statsPageSummary(command, currentWeek) {
  const monthActual = command.dayPlans
    .filter((day) => day.date >= command.currentMonthStart && day.date <= command.currentMonthEnd)
    .reduce((sum, day) => sum + Number(day.actual || 0), 0);
  const incentiveTotal = command.incentives.length;
  const incentiveMet = command.incentives.filter((item) => item.status === "achieved" || item.status === "claimed").length;
  return {
    week: {
      actual: Number(currentWeek.actual ?? command.currentWeekActual ?? 0),
      goal: Number(currentWeek.weekly_goal || 0),
      progress: Number(currentWeek.progress || 0),
    },
    month: {
      actual: monthActual,
      goal: 0,
    },
    season: {
      actual: command.completed,
      goal: Number(command.plan.total_goal || 0),
      progress: command.plan.total_goal > 0 ? (command.completed / command.plan.total_goal) * 100 : 0,
    },
    incentives: {
      met: incentiveMet,
      total: incentiveTotal,
    },
  };
}

function weeklyOverviewCardClass(label, isFuture) {
  if (isFuture) return "border-indigo-100 bg-indigo-50/40 dark:border-indigo-400/20";
  if (label === "Diamond") return "border-cyan-200 bg-cyan-50/70 dark:border-cyan-300/30";
  if (label === "Gold") return "border-yellow-300 bg-yellow-50/80 dark:border-yellow-200/40";
  if (label === "Silver") return "border-slate-300 bg-slate-50 dark:border-slate-500";
  if (label === "Bronze") return "border-[#d69a5b]/50 bg-[#fff7ed] dark:border-[#d69a5b]/40";
  return "border-slate-200 bg-white dark:border-slate-700";
}

function weeklyGraphData(weeks) {
  return weeks.map((week, index) => ({
    label: `W${week.seasonWeekNumber || index + 1}`,
    actual: Number(week.actual || 0),
    goal: Number(week.weekly_goal || 0),
  }));
}

function GoalsPage({ workspace, command, savePlan }) {
  const [draft, setDraft] = useState(workspace.plan);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const preview = buildDatePreview(command, draft);

  useEffect(() => {
    setDraft(workspace.plan);
    setEditing(false);
  }, [workspace.plan]);

  function cancelEdit() {
    setDraft(workspace.plan);
    setEditing(false);
  }

  async function applyChanges() {
    if (saving) return;
    setSaving(true);
    try {
      await savePlan(normalizePlanDraft(draft));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 md:gap-5">
      <PageIntro
        eyebrow="Goals"
        title="Sales goals and dates"
        description="Review your plan at a glance. Use Edit Goals when you need to change the numbers."
      />
      <SettingsBlock title="Sales Plan" description="Review the core goals and dates for this season." icon={Target}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-bold text-slate-500">
            {editing ? "Edit carefully. These numbers recalculate your plan." : "Locked summary. Tap Edit Goals to make changes."}
          </div>
          <button
            type="button"
            onClick={editing ? cancelEdit : () => setEditing(true)}
            disabled={saving}
            className={`${editing ? "app-secondary-button" : "app-primary-button"} px-5 py-3 text-sm`}
          >
            {editing ? "Cancel" : "Edit Goals"}
          </button>
        </div>

        {editing ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field label="Plan name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
            <Field label="Season goal" type="number" value={draft.total_goal} onChange={(v) => setDraft({ ...draft, total_goal: v })} />
            <Field label="Starting sales" type="number" value={draft.starting_sales} onChange={(v) => setDraft({ ...draft, starting_sales: v })} />
            <Field label="Default weekly goal" type="number" value={draft.default_weekly_goal} onChange={(v) => setDraft({ ...draft, default_weekly_goal: v })} />
            <Field label="Max realistic sales/day" type="number" value={draft.max_sales_per_day} onChange={(v) => setDraft({ ...draft, max_sales_per_day: v })} />
            <Field label="Season start" type="date" value={draft.start_date} onChange={(v) => setDraft({ ...draft, start_date: v })} />
            <Field label="Season end" type="date" value={draft.end_date} onChange={(v) => setDraft({ ...draft, end_date: v })} />
            <Field label="Tracking start" type="date" value={draft.tracking_start_date} onChange={(v) => setDraft({ ...draft, tracking_start_date: v })} />
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
            <div className="md:col-span-2 xl:col-span-3">
              <Toggle label="Include outside-range sales in calculations" checked={draft.include_outside_range_sales} onChange={(v) => setDraft({ ...draft, include_outside_range_sales: v })} />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <SettingsSummary label="Plan name" value={workspace.plan.name} />
            <SettingsSummary label="Season goal" value={`${number(workspace.plan.total_goal)} sales`} />
            <SettingsSummary label="Starting sales" value={number(workspace.plan.starting_sales)} />
            <SettingsSummary label="Default weekly goal" value={`${number(workspace.plan.default_weekly_goal)} sales`} />
            <SettingsSummary label="Max sales/day" value={number(workspace.plan.max_sales_per_day, 1)} />
            <SettingsSummary label="Season start" value={formatDate(workspace.plan.start_date)} />
            <SettingsSummary label="Season end" value={formatDate(workspace.plan.end_date)} />
            <SettingsSummary label="Tracking start" value={formatDate(workspace.plan.tracking_start_date)} />
            <SettingsSummary label="Catch-up strategy" value={String(workspace.plan.catchup_strategy || "balanced").replaceAll("_", " ")} />
          </div>
        )}

        {editing && (
          <>
            <div className={`mt-5 rounded-3xl p-4 ${preview.warning ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}`}>
              <div className="flex items-center gap-2 font-black">
                {preview.warning ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />} Preview
              </div>
              <p className="mt-1 text-sm font-semibold">{preview.message}</p>
            </div>
            <button
              type="button"
              onClick={applyChanges}
              disabled={saving}
              className="mt-5 w-full rounded-2xl bg-emerald-600 px-5 py-3 font-black text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </>
        )}

        {command.outsideRangeEntries.length > 0 && (
          <div className="mt-4 rounded-3xl bg-red-50 p-4 text-sm font-bold text-red-700">
            {command.outsideRangeEntries.length} sales entries fall outside the active date range. They are kept saved and follow your outside-range setting.
          </div>
        )}
      </SettingsBlock>
    </div>
  );
}

const incentiveFilters = [
  { value: "all", label: "All" },
  { value: "personal", label: "Personal" },
  { value: "company", label: "Company" },
  { value: "month", label: "Monthly" },
  { value: "week", label: "Weekly" },
  { value: "day", label: "Daily" },
  { value: "custom", label: "Custom" },
];

function IncentivesPage({ command, workspace, saveIncentive, removeIncentive }) {
  const [editingReward, setEditingReward] = useState(null);
  const [claimingRewardId, setClaimingRewardId] = useState("");
  const [claimedRewardId, setClaimedRewardId] = useState("");
  const [confettiKey, setConfettiKey] = useState(0);
  const [activeFilter, setActiveFilter] = useState("all");
  const claimFeedbackTimerRef = useRef(null);
  const rewards = dedupeById(command.incentives)
    .filter((item) => String(item.title || "").trim())
    .map(normalizeIncentiveDisplayFields);
  const filteredRewards = rewards.filter((item) => incentiveMatchesFilter(item, activeFilter));
  const rewardGroups = organizeRewards(filteredRewards);
  const monthlyRewards = rewards.filter((item) => item.incentive_period === "month");
  const achievedCount = rewards.filter((item) => item.status === "achieved" || item.status === "claimed").length;
  const nextReward = command.nextIncentive;

  useEffect(() => () => window.clearTimeout(claimFeedbackTimerRef.current), []);

  async function claimReward(item) {
    if (!item?.id || claimingRewardId || item.status === "claimed") return;
    setClaimingRewardId(item.id);
    try {
      await saveIncentive({ ...item, status: "claimed" });
      setClaimedRewardId(item.id);
      setConfettiKey(Date.now());
      window.clearTimeout(claimFeedbackTimerRef.current);
      claimFeedbackTimerRef.current = window.setTimeout(() => setClaimedRewardId(""), 1800);
    } finally {
      setClaimingRewardId("");
    }
  }

  async function reopenReward(item) {
    if (!item?.id || claimingRewardId || item.status !== "claimed") return;
    if (!window.confirm("Move this reward back to active?")) return;
    setClaimingRewardId(item.id);
    try {
      const status = item.progress >= 100 ? "achieved" : item.progress > 0 ? "in_progress" : "locked";
      await saveIncentive({ ...item, status });
    } finally {
      setClaimingRewardId("");
    }
  }

  function renderReward(item) {
    return (
      <RewardCard
        key={item.id}
        incentive={item}
        onEdit={() => setEditingReward(item)}
        onClaim={() => claimReward(item)}
        onReopen={() => reopenReward(item)}
        onDelete={() => removeIncentive(item.id)}
        saving={claimingRewardId === item.id}
        recentlyClaimed={claimedRewardId === item.id}
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4 md:gap-5">
      <IncentiveConfetti burstKey={confettiKey} />
      <PageIntro
        eyebrow="Incentives"
        title="Rewards"
        description="Set a few clean milestones and let the app track progress automatically."
      />
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
        <Card title="Reward Summary" icon={Gift} compact className="incentive-outline">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Rewards" value={`${number(achievedCount)} / ${number(rewards.length)}`} detail="Achieved or claimed" />
            <StatTile
              label="Next Reward"
              value={nextReward ? nextReward.title : "None yet"}
              detail={nextReward ? `${number(Math.max(0, nextReward.target - nextReward.current), 1)} away` : "Add one to track progress"}
            />
            <StatTile label="Ready to Claim" value={number(rewards.filter((item) => item.status === "achieved").length)} detail="Goals completed" />
            <StatTile label="Claimed" value={number(rewards.filter((item) => item.status === "claimed").length)} detail="Rewards collected" />
          </div>
        </Card>
        <Card title="Reward Setup" icon={PlusCircle} compact className="incentive-outline">
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-500">
              Set personal or company rewards for a season, month, week, day, or custom date range.
            </p>
            {!rewards.length && (
              <div className="mt-4 rounded-3xl bg-purple-50 p-4 text-sm font-bold text-purple-800 dark:bg-purple-950/30 dark:text-purple-100">
                No rewards yet. Add your first reward to make hitting your goals more fun.
              </div>
            )}
            <div className="mt-4 rounded-3xl bg-purple-50/70 p-2 ring-1 ring-purple-100 dark:bg-purple-950/20 dark:ring-purple-800/50">
              <button
                type="button"
                onClick={() => setEditingReward(newIncentive(workspace.plan.id))}
                disabled={Boolean(editingReward)}
                className="min-h-12 w-full rounded-2xl bg-purple-600 px-5 py-3 text-sm font-black text-white shadow-card transition hover:bg-purple-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Add Reward
              </button>
            </div>
          </div>
        </Card>
      </div>

      {monthlyRewards.length > 0 && <MonthlyGoalsSection rewards={monthlyRewards} />}

      <Card title="Your Rewards" icon={Trophy} compact className="incentive-outline">
        <div className="mb-5" aria-label="Filter incentives">
          <div className="flex flex-wrap gap-2">
            {incentiveFilters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setActiveFilter(filter.value)}
                aria-pressed={activeFilter === filter.value}
                className={`rounded-full px-4 py-2 text-sm font-black transition ${
                  activeFilter === filter.value
                    ? "bg-purple-600 text-white shadow-sm"
                    : "bg-slate-100 text-slate-600 hover:bg-purple-50 hover:text-purple-700 dark:bg-slate-800 dark:text-slate-200"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        {filteredRewards.length ? (
          <div className="grid gap-6">
            <RewardGroup
              title="Ready to claim"
              description="You hit these goals. Collect the rewards when you are ready."
              rewards={rewardGroups.ready}
              tone="ready"
              renderReward={renderReward}
            />
            <RewardGroup
              title="In progress"
              description="Active rewards, ordered by how close they are."
              rewards={rewardGroups.active}
              tone="active"
              renderReward={renderReward}
            />
            <RewardGroup
              title="Claimed"
              description="Rewards you have already collected."
              rewards={rewardGroups.claimed}
              tone="claimed"
              renderReward={renderReward}
            />
          </div>
        ) : (
          <div className="rounded-3xl bg-slate-50 p-5 text-sm font-bold text-slate-500 dark:bg-slate-950">
            {rewards.length ? "No rewards match this filter." : "Your saved rewards will show here."}
          </div>
        )}
      </Card>
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

function normalizeIncentiveDisplayFields(incentive) {
  return {
    ...incentive,
    incentive_source: incentive.incentive_source || "personal",
    incentive_period: incentive.incentive_period || (incentive.incentive_type === "weekly_goal" ? "week" : "season"),
  };
}

function incentiveMatchesFilter(incentive, filter) {
  if (filter === "all") return true;
  if (filter === "personal" || filter === "company") return incentive.incentive_source === filter;
  return incentive.incentive_period === filter;
}

function organizeRewards(rewards) {
  const byProgress = (a, b) =>
    Number(b.progress || 0) - Number(a.progress || 0) ||
    Number(a.target || 0) - Number(b.target || 0) ||
    String(a.title || "").localeCompare(String(b.title || ""));
  const byMostRecent = (a, b) =>
    String(b.updated_at || "").localeCompare(String(a.updated_at || "")) ||
    String(a.title || "").localeCompare(String(b.title || ""));

  return {
    ready: rewards.filter((item) => item.status === "achieved").sort(byProgress),
    active: rewards.filter((item) => item.status !== "achieved" && item.status !== "claimed").sort(byProgress),
    claimed: rewards.filter((item) => item.status === "claimed").sort(byMostRecent),
  };
}

function RewardGroup({ title, description, rewards, tone, renderReward }) {
  if (!rewards.length) return null;
  const toneClasses = {
    ready: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-100 dark:ring-emerald-800/60",
    active: "bg-purple-50 text-purple-800 ring-purple-200 dark:bg-purple-950/30 dark:text-purple-100 dark:ring-purple-800/60",
    claimed: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-950 dark:text-slate-200 dark:ring-slate-700",
  };

  return (
    <section aria-labelledby={`reward-group-${tone}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`reward-group-${tone}`} className="text-lg font-black text-slate-950 dark:text-slate-50">{title}</h3>
          <p className="mt-1 text-sm font-bold text-slate-500">{description}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${toneClasses[tone]}`}>{rewards.length}</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rewards.map(renderReward)}
      </div>
    </section>
  );
}

function MonthlyGoalsSection({ rewards }) {
  const sources = [
    { value: "personal", label: "Personal Monthly" },
    { value: "company", label: "Company Monthly" },
  ];
  return (
    <Card title="Monthly Goals" icon={Calendar} compact className="incentive-outline">
      <div className="grid gap-4 lg:grid-cols-2">
        {sources.map((source) => {
          const sourceRewards = rewards.filter((item) => item.incentive_source === source.value);
          return (
            <section key={source.value} className="min-w-0 rounded-3xl bg-slate-50 p-4 dark:bg-slate-950">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-black text-slate-950 dark:text-slate-50">{source.label}</h3>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-200">
                  {sourceRewards.length}
                </span>
              </div>
              {sourceRewards.length ? (
                <div className="grid gap-3">
                  {sourceRewards.map((item) => (
                    <div key={item.id} className="rounded-2xl bg-white p-3 shadow-sm dark:bg-slate-900">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-black text-slate-950 dark:text-slate-50">{item.title}</div>
                          <div className="mt-1 text-xs font-bold text-slate-500">{incentiveDateLabel(item)}</div>
                        </div>
                        <Badge tone={incentiveStatusTone(item.status)}>{incentiveStatusLabel(item.status)}</Badge>
                      </div>
                      <Progress value={item.progress} tone="purple" />
                      <div className="mt-2 text-xs font-black text-slate-500">
                        {number(item.current, 1)} / {number(item.target, 1)} sales
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm font-bold text-slate-500">No {source.value} monthly rewards yet.</p>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}

function IncentiveConfetti({ burstKey }) {
  if (!burstKey) return null;
  const pieces = [
    ["-34vw", "-22vh", "#7c3aed", "86deg"],
    ["-25vw", "-31vh", "#a855f7", "142deg"],
    ["-15vw", "-26vh", "#22c55e", "222deg"],
    ["-6vw", "-36vh", "#facc15", "308deg"],
    ["6vw", "-32vh", "#06b6d4", "44deg"],
    ["16vw", "-27vh", "#ec4899", "132deg"],
    ["26vw", "-30vh", "#8b5cf6", "238deg"],
    ["35vw", "-20vh", "#10b981", "315deg"],
    ["-38vw", "2vh", "#f59e0b", "188deg"],
    ["-28vw", "11vh", "#38bdf8", "256deg"],
    ["-18vw", "18vh", "#c084fc", "31deg"],
    ["-7vw", "9vh", "#34d399", "111deg"],
    ["7vw", "14vh", "#f472b6", "201deg"],
    ["18vw", "20vh", "#fde047", "283deg"],
    ["29vw", "9vh", "#60a5fa", "349deg"],
    ["38vw", "1vh", "#a78bfa", "76deg"],
    ["-12vw", "-8vh", "#fb7185", "167deg"],
    ["13vw", "-10vh", "#2dd4bf", "247deg"],
    ["-3vw", "24vh", "#fbbf24", "317deg"],
    ["3vw", "25vh", "#9333ea", "27deg"],
  ];
  return (
    <div key={burstKey} className="claim-confetti" aria-hidden="true">
      {pieces.map(([x, y, color, rotation], index) => (
        <span key={index} style={{ "--x": x, "--y": y, "--color": color, "--r": rotation }} />
      ))}
    </div>
  );
}

function IncentivePanel({ title, icon: Icon, children }) {
  return (
    <section className="incentive-outline rounded-[2rem] p-4 md:p-5">
      <div className="mb-3 flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-purple-600 text-white shadow-sm">
          <Icon size={19} />
        </div>
        <h2 className="text-lg font-black text-slate-950 dark:text-slate-50">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function RewardCard({ incentive, onEdit, onClaim, onReopen, onDelete, saving = false, recentlyClaimed = false }) {
  const claimed = incentive.status === "claimed";
  return (
    <article className={`incentive-outline min-w-0 rounded-[1.5rem] p-4 ${recentlyClaimed ? "celebrate" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words text-xl font-black text-slate-950 dark:text-slate-50">{incentive.title}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-black ${
              incentive.incentive_source === "company"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200"
                : "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-200"
            }`}>
              {incentive.incentive_source === "company" ? "Company" : "Personal"}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-600 dark:bg-slate-800 dark:text-slate-200">
              {incentivePeriodLabel(incentive.incentive_period)}
            </span>
          </div>
        </div>
        <Badge tone={incentiveStatusTone(incentive.status)}>{incentiveStatusLabel(incentive.status)}</Badge>
      </div>
      <div className="mt-3 text-sm font-bold text-slate-500">{incentiveDateLabel(incentive)}</div>
      {incentive.description && <p className="mt-2 break-words text-sm font-semibold text-slate-600 dark:text-slate-300">{incentive.description}</p>}
      <Progress value={incentive.progress} tone="purple" />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm font-bold text-slate-500">
        <span>{number(incentive.current, 1)} / {number(incentive.target, 1)} sales</span>
        <span>{percent(incentive.progress)}</span>
      </div>
      {incentive.reward_value !== null && incentive.reward_value !== undefined && incentive.reward_value !== "" && (
        <div className="mt-3 rounded-2xl bg-purple-50 px-3 py-2 text-sm font-black text-purple-800 dark:bg-purple-950/30 dark:text-purple-100">
          Value / cost: {number(incentive.reward_value, 2)}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={saving} className="app-secondary-button px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60">
          Edit
        </button>
        {incentive.status === "achieved" && (
          <button
            type="button"
            onClick={onClaim}
            disabled={saving}
            className="rounded-2xl bg-purple-600 px-4 py-3 text-sm font-black text-white transition hover:bg-purple-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {saving ? "Saving..." : "Claim"}
          </button>
        )}
        {claimed && (
          <button
            type="button"
            onClick={onReopen}
            disabled={saving}
            className="rounded-2xl bg-amber-50 px-4 py-3 text-sm font-black text-amber-800 ring-1 ring-amber-200 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-700/50"
          >
            {saving ? "Saving..." : "Reopen"}
          </button>
        )}
        <button type="button" onClick={onDelete} disabled={saving} className="app-danger-button px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60">
          Delete
        </button>
      </div>
    </article>
  );
}

function RewardModal({ incentive, onSave, onClose }) {
  const [draft, setDraft] = useState(() => normalizeIncentiveDisplayFields(incentive));
  const [more, setMore] = useState(Boolean(incentive.description || incentive.reward_value));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const submitLock = useRef(false);

  async function submit(event) {
    event.preventDefault();
    if (submitLock.current) return;
    let payload;
    try {
      payload = normalizeIncentiveDraft(draft, incentive.plan_id);
    } catch (err) {
      setFormError(err.message);
      return;
    }
    submitLock.current = true;
    setIsSubmitting(true);
    setFormError("");
    try {
      await onSave(payload);
    } catch (err) {
      submitLock.current = false;
      setFormError(err.message);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-end overflow-x-hidden bg-slate-950/45 sm:place-items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[92vh] w-full min-w-0 overflow-y-auto overflow-x-hidden rounded-t-[2rem] bg-white p-5 shadow-glow dark:bg-slate-900 sm:max-w-2xl sm:rounded-[2rem] md:p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-black uppercase tracking-wide text-purple-600">Reward</div>
            <h2 className="text-2xl font-black text-slate-950 dark:text-slate-50">{draft.id ? "Edit reward" : "Add reward"}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={isSubmitting} className="app-secondary-button px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60">
            Cancel
          </button>
        </div>
        <div className="grid gap-4">
          <Field label="Reward name" value={draft.title} required onChange={(v) => setDraft({ ...draft, title: v })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Reward source"
              type="select"
              value={draft.incentive_source}
              onChange={(v) => setDraft({ ...draft, incentive_source: v })}
              options={[
                { value: "personal", label: "Personal" },
                { value: "company", label: "Company" },
              ]}
            />
            <Field
              label="Reward goal"
              type="select"
              value={draft.incentive_period}
              onChange={(v) => setDraft({ ...draft, incentive_period: v })}
              options={[
                { value: "season", label: "Season" },
                { value: "month", label: "Monthly" },
                { value: "week", label: "Weekly" },
                { value: "day", label: "Daily" },
                { value: "custom", label: "Custom" },
              ]}
            />
          </div>
          <Field label="Target sales" type="number" value={draft.target_value} onChange={(v) => setDraft({ ...draft, target_value: v })} />
          <IncentivePeriodFields draft={draft} onChange={setDraft} />
        </div>
        <button type="button" onClick={() => setMore((value) => !value)} className="app-secondary-button mt-4 px-4 py-3 text-sm">
          {more ? "Hide more options" : "More options"}
        </button>
        {more && (
          <div className="mt-4 grid gap-4 rounded-3xl bg-slate-50 p-4">
            <Field label="Description" type="textarea" value={draft.description || ""} onChange={(v) => setDraft({ ...draft, description: v })} />
            <Field label="Reward value / cost" type="number" value={draft.reward_value ?? ""} onChange={(v) => setDraft({ ...draft, reward_value: v })} />
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

function IncentivePeriodFields({ draft, onChange }) {
  if (draft.incentive_period === "month") {
    return (
      <Field
        label="Reward month"
        type="month"
        value={String(draft.target_date || "").slice(0, 7)}
        onChange={(value) => onChange({ ...draft, target_date: value ? `${value}-01` : "" })}
      />
    );
  }
  if (draft.incentive_period === "week") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Week start"
          type="date"
          value={draft.start_date || ""}
          onChange={(value) => {
            const parsed = parseISO(value);
            onChange({
              ...draft,
              start_date: value,
              end_date: parsed ? toISO(addDays(parsed, 6)) : "",
            });
          }}
        />
        <Field label="Week end" type="date" value={draft.end_date || ""} onChange={(value) => onChange({ ...draft, end_date: value })} />
      </div>
    );
  }
  if (draft.incentive_period === "day") {
    return <Field label="Reward date" type="date" value={draft.target_date || ""} onChange={(value) => onChange({ ...draft, target_date: value })} />;
  }
  if (draft.incentive_period === "custom") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date" type="date" value={draft.start_date || ""} onChange={(value) => onChange({ ...draft, start_date: value })} />
        <Field label="End date" type="date" value={draft.end_date || ""} onChange={(value) => onChange({ ...draft, end_date: value })} />
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-purple-50 px-4 py-3 text-sm font-bold text-purple-800 dark:bg-purple-950/30 dark:text-purple-100">
      This reward tracks progress across the full season.
    </div>
  );
}

function incentivePeriodLabel(period) {
  return {
    season: "Season",
    month: "Monthly",
    week: "Weekly",
    day: "Daily",
    custom: "Custom",
  }[period] || "Season";
}

function incentiveDateLabel(incentive) {
  if (incentive.incentive_period === "month") return formatMonth(incentive.target_date || incentive.period_start);
  if (incentive.incentive_period === "week" || incentive.incentive_period === "custom") {
    const start = incentive.start_date || incentive.period_start;
    const end = incentive.end_date || incentive.period_end;
    return start && end ? formatRange(start, end) : "Date range not set";
  }
  if (incentive.incentive_period === "day") return incentive.target_date ? formatDate(incentive.target_date) : "Date not set";
  return "Full season";
}

function incentiveStatusLabel(status) {
  return String(status || "locked").replaceAll("_", " ");
}

function incentiveStatusTone(status) {
  if (status === "achieved") return "ahead";
  if (status === "locked") return "neutral";
  return "on_track";
}

function SettingsPage({ user, workspace, saveSettings, savePlan, onSendPasswordReset, onResetStats }) {
  const [blocks, setBlocks] = useState(normalizeTimeBlocks(workspace.settings.time_blocks_config));
  const [defaultWeeklyGoal, setDefaultWeeklyGoal] = useState(workspace.plan.default_weekly_goal || 0);
  const [passwordStatus, setPasswordStatus] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [sendingPassword, setSendingPassword] = useState(false);
  const [resetStatus, setResetStatus] = useState("");
  const [resetError, setResetError] = useState("");
  const [confirmResetStats, setConfirmResetStats] = useState(false);
  const [resettingStats, setResettingStats] = useState(false);
  useEffect(() => setBlocks(normalizeTimeBlocks(workspace.settings.time_blocks_config)), [workspace.settings.time_blocks_config]);
  useEffect(() => setDefaultWeeklyGoal(workspace.plan.default_weekly_goal || 0), [workspace.plan.default_weekly_goal]);

  function updateBlock(key, changes) {
    setBlocks((current) => current.map((block) => (block.key === key ? { ...block, ...changes } : block)));
  }

  async function sendPasswordReset() {
    if (!user.email || sendingPassword) return;
    setSendingPassword(true);
    setPasswordStatus("");
    setPasswordError("");
    try {
      await onSendPasswordReset();
      setPasswordStatus("Password reset email sent.");
    } catch (err) {
      setPasswordError(passwordResetMessage(err));
    } finally {
      setSendingPassword(false);
    }
  }

  async function confirmReset() {
    if (resettingStats) return;
    setResettingStats(true);
    setResetStatus("");
    setResetError("");
    try {
      const ok = await onResetStats();
      if (!ok) throw new Error("Could not reset stats. Try again.");
      setResetStatus("Stats reset. Your plan, schedule, blackout dates, and rewards are still here.");
      setConfirmResetStats(false);
    } catch (err) {
      setResetError(err.message);
    } finally {
      setResettingStats(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4 md:gap-5">
      <PageIntro
        eyebrow="Settings"
        title="App settings"
        description="Manage preferences, schedule assumptions, account safety, and reset controls."
      />
      <SettingsBlock title="Plan basics" description="Your main plan targets and default weekly pace." icon={Target}>
        <div className="grid gap-3 sm:grid-cols-2">
          <SettingsSummary label="Plan name" value={workspace.plan.name} />
          <SettingsSummary label="Season goal" value={`${number(workspace.plan.total_goal)} sales`} />
          <SettingsSummary label="Season dates" value={`${formatDate(workspace.plan.start_date, { year: undefined })} - ${formatDate(workspace.plan.end_date, { year: undefined })}`} />
          <div className="grid gap-2">
            <Field label="Default weekly goal" type="number" value={defaultWeeklyGoal} onChange={setDefaultWeeklyGoal} />
            <p className="text-xs font-bold text-slate-500">Used for weeks without a custom goal.</p>
            <button
              type="button"
              onClick={() => savePlan({ default_weekly_goal: Number(defaultWeeklyGoal || 0) })}
              className="app-primary-button px-4 py-3 text-sm"
            >
              Save default weekly goal
            </button>
          </div>
        </div>
      </SettingsBlock>

      <SettingsBlock title="Schedule" description="Choose which days count and how the sales week is organized." icon={Calendar}>
        <WeekdayPicker value={workspace.settings.normal_workdays} onChange={(normal_workdays) => saveSettings({ normal_workdays })} />
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Week starts on" type="select" value={workspace.settings.default_week_start_day} onChange={(v) => saveSettings({ default_week_start_day: Number(v) })} options={weekdayOptions} />
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
          <SettingsSummary label="Workdays selected" value={`${workspace.settings.normal_workdays?.length || 0} days`} />
          <SettingsSummary label="Time blocks" value={`${blocks.filter((block) => block.active).length} active`} />
        </div>
      </SettingsBlock>

      <SettingsBlock title="Time blocks" description="Edit how today's goal is split across the day." icon={Clock}>
        <div className="grid gap-3">
          {blocks.map((block) => (
            <div key={block.key} className="grid gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950 xl:grid-cols-[1fr_0.8fr_0.8fr_0.7fr_auto]">
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
          <button type="button" onClick={() => saveSettings({ time_blocks_config: blocks })} className="app-primary-button">
            Save time blocks
          </button>
          <button type="button" onClick={() => setBlocks(defaultTimeBlocks)} className="app-secondary-button">
            Reset defaults
          </button>
        </div>
      </SettingsBlock>

      <SettingsBlock title="App preferences" description="Keep the app comfortable for how you like to work." icon={CheckCircle2}>
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
      </SettingsBlock>

      <SettingsBlock title="Account Safety" description="Send a secure password reset email for this account." icon={Settings}>
        <SettingsSummary label="Email" value={user.email} />
        {user.email ? (
          <button
            type="button"
            onClick={sendPasswordReset}
            disabled={sendingPassword}
            className="mt-4 w-full rounded-2xl bg-indigo-600 px-5 py-3 font-black text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {sendingPassword ? "Sending..." : "Send password reset email"}
          </button>
        ) : (
          <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800">No email is available for this account.</div>
        )}
        {passwordStatus && <div className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-700">{passwordStatus}</div>}
        {passwordError && <div className="mt-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700">{passwordError}</div>}
      </SettingsBlock>

      <SettingsBlock title="Danger Zone" description="Destructive controls are intentionally separated." icon={AlertTriangle} tone="danger">
        <div className="grid gap-4 rounded-3xl bg-red-50 p-4 dark:bg-red-950/30">
          <div>
            <div className="font-black text-red-800 dark:text-red-100">Reset Stats</div>
            <p className="mt-1 text-sm font-bold text-red-700 dark:text-red-200">
              Clears sales progress but keeps your plan, goals, schedule, blackout dates, and rewards.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmResetStats(true)}
            className="w-full rounded-2xl bg-red-600 px-5 py-3 font-black text-white transition active:scale-[0.99] sm:w-auto"
          >
            Reset Stats
          </button>
          {resetStatus && <div className="rounded-2xl bg-white/70 p-3 text-sm font-bold text-emerald-700 dark:bg-slate-950/40 dark:text-emerald-200">{resetStatus}</div>}
          {resetError && <div className="rounded-2xl bg-white/70 p-3 text-sm font-bold text-red-700 dark:bg-slate-950/40 dark:text-red-200">{resetError}</div>}
        </div>
      </SettingsBlock>
      {confirmResetStats && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-slate-950/45 px-3 sm:place-items-center">
          <div className="w-full max-w-md rounded-t-[2rem] bg-white p-5 shadow-glow dark:bg-slate-900 sm:rounded-[2rem]">
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-200">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h2 className="text-xl font-black text-slate-950 dark:text-slate-50">Reset stats?</h2>
                <p className="mt-1 text-sm font-bold text-slate-500">
                  This clears sales progress but keeps your plan, goals, schedule, blackout dates, and rewards.
                </p>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfirmResetStats(false)}
                disabled={resettingStats}
                className="rounded-2xl bg-slate-100 px-4 py-3 font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-800 dark:text-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReset}
                disabled={resettingStats}
                className="rounded-2xl bg-red-600 px-4 py-3 font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {resettingStats ? "Resetting..." : "Reset Stats"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PageIntro({ eyebrow, title, description }) {
  return (
    <div className="max-w-3xl">
      <div className="text-sm font-black uppercase tracking-wide text-indigo-600 dark:text-indigo-300">{eyebrow}</div>
      <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950 dark:text-slate-50 md:text-3xl">{title}</h2>
      {description && <p className="mt-2 text-sm font-bold leading-6 text-slate-500 dark:text-slate-400">{description}</p>}
    </div>
  );
}

function SettingsBlock({ title, description, icon: Icon, children, tone = "default" }) {
  const iconClass = tone === "danger" ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-200" : "bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950";
  return (
    <section className="app-card">
      <div className="mb-5 flex items-start gap-3">
        <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${iconClass}`}>
          <Icon size={20} />
        </div>
        <div className="min-w-0">
          <h2 className="text-xl font-black text-slate-950 dark:text-slate-50">{title}</h2>
          {description && <p className="mt-1 text-sm font-bold text-slate-500">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function SettingsSummary({ label, value }) {
  return (
    <div className="app-secondary-surface">
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 break-words text-lg font-black text-slate-950 dark:text-slate-50">{value}</div>
    </div>
  );
}

function passwordResetMessage(error) {
  const message = error?.message || "Could not send the reset email.";
  const lower = message.toLowerCase();
  if (lower.includes("rate") || lower.includes("limit") || lower.includes("too many")) {
    return "Email limit reached. Try again later or set up custom SMTP.";
  }
  return message;
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
      <div className="max-h-[92vh] w-full max-w-md overflow-auto rounded-[2rem] bg-white p-5 shadow-glow md:max-w-2xl md:p-6">
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
  useEffect(() => setDraft(week), [week]);
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
          <WeekMiniEditor week={draft} defaultWeeklyGoal={command.plan.default_weekly_goal} onChange={setDraft} />
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

function Card({ title, icon: Icon, children, compact = false, className = "" }) {
  return (
    <section className={`app-card ${compact ? "p-4" : "p-5"} ${className}`}>
      <div className={`${compact ? "mb-3" : "mb-5"} flex items-center gap-3`}>
        <div className={`${compact ? "h-10 w-10" : "h-11 w-11"} app-icon`}>
          <Icon size={20} />
        </div>
        <h2 className={`${compact ? "text-lg" : "text-xl"} font-black text-slate-950 dark:text-slate-50`}>{title}</h2>
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
      <span className="text-sm font-black text-slate-600 dark:text-slate-300">{label}</span>
      {type === "select" ? (
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="app-field">
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="app-field app-textarea" />
      ) : (
        <input required={required} type={type} value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="app-field" />
      )}
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="mt-5 flex items-center gap-3 rounded-2xl bg-slate-50 p-4 font-bold text-slate-700 dark:bg-slate-950 dark:text-slate-200">
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
    <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
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
    <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-950">
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-black text-slate-950 dark:text-slate-50">{value}</div>
    </div>
  );
}

function StatTile({ label, value, detail }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950">
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-black text-slate-950 dark:text-slate-50">{value}</div>
      <div className="mt-1 text-sm font-bold text-slate-500">{detail}</div>
    </div>
  );
}

function CompactMetric({ label, value, className = "", valueClassName = "" }) {
  return (
    <div className={`rounded-2xl bg-slate-50 px-3 py-3 transition-all duration-500 dark:bg-slate-950 ${className}`}>
      <div className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-black text-slate-950 transition-colors duration-500 dark:text-slate-50 ${valueClassName}`}>{value}</div>
    </div>
  );
}

function EditableList({ items, empty, render }) {
  return (
    <div className="mt-5 grid gap-3">
      {items.length ? items.map((item, index) => <div key={item.id || item.setupId || index}>{render(item, index)}</div>) : <div className="rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-500">{empty}</div>}
    </div>
  );
}

function WeekMiniEditor({ week, defaultWeeklyGoal, onChange, onDelete }) {
  const usingCustomGoal = Boolean(week.custom_goal_enabled);
  return (
    <div className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 md:grid-cols-5">
      <Field label="Label" value={week.range_label || ""} onChange={(v) => onChange({ ...week, range_label: v })} />
      <Field label="Start" type="date" value={week.week_start} onChange={(v) => onChange({ ...week, week_start: v })} />
      <Field label="End" type="date" value={week.week_end} onChange={(v) => onChange({ ...week, week_end: v })} />
      <div className="grid gap-2">
        <Field label="Goal" type="number" value={week.weekly_goal} onChange={(v) => onChange({ ...week, weekly_goal: v, custom_goal_enabled: true })} />
        <span className="text-xs font-bold text-slate-500">{usingCustomGoal ? "Custom week goal" : "Using default goal"}</span>
        {usingCustomGoal && (
          <button
            type="button"
            onClick={() => onChange({ ...week, weekly_goal: Number(defaultWeeklyGoal || 0), custom_goal_enabled: false })}
            className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-700"
          >
            Reset to default
          </button>
        )}
      </div>
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

function normalizeIncentiveDraft(incentive, planId) {
  const title = String(incentive.title || "").trim();
  const target = parseNumericInput(incentive.target_value);
  const rewardValue = optionalNumber(incentive.reward_value);
  const source = incentive.incentive_source === "company" ? "company" : "personal";
  const allowedPeriods = ["season", "month", "week", "day", "custom"];
  const period = allowedPeriods.includes(incentive.incentive_period) ? incentive.incentive_period : "season";
  let targetDate = null;
  let startDate = null;
  let endDate = null;
  if (!title) throw new Error("Reward name is required.");
  if (!Number.isFinite(target) || target <= 0) throw new Error("Reward goal must be greater than 0.");
  if (!isBlank(incentive.reward_value) && (!Number.isFinite(rewardValue) || rewardValue < 0)) {
    throw new Error("Reward value must be 0 or higher.");
  }
  if (period === "month") {
    targetDate = String(incentive.target_date || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(targetDate)) throw new Error("Choose a reward month.");
    targetDate = `${targetDate}-01`;
  }
  if (period === "week") {
    startDate = incentive.start_date || null;
    if (!parseISO(startDate)) throw new Error("Choose a week start date.");
    endDate = incentive.end_date || toISO(addDays(parseISO(startDate), 6));
    if (!parseISO(endDate) || endDate < startDate) throw new Error("Week end must be on or after week start.");
  }
  if (period === "day") {
    targetDate = incentive.target_date || null;
    if (!parseISO(targetDate)) throw new Error("Choose a reward date.");
  }
  if (period === "custom") {
    startDate = incentive.start_date || null;
    endDate = incentive.end_date || null;
    if (!parseISO(startDate) || !parseISO(endDate)) throw new Error("Choose a custom start and end date.");
    if (endDate < startDate) throw new Error("Custom end date must be on or after the start date.");
  }
  return {
    ...(incentive.id ? { id: incentive.id } : {}),
    plan_id: planId || incentive.plan_id,
    title,
    description: String(incentive.description || "").trim(),
    incentive_type: incentiveTypeForPeriod(period),
    incentive_source: source,
    incentive_period: period,
    target_value: target,
    target_date: targetDate,
    start_date: startDate,
    end_date: endDate,
    related_goal_period_id: incentive.related_goal_period_id || null,
    reward_value: rewardValue,
    status: incentive.status || "locked",
  };
}

function incentiveTypeForPeriod(period) {
  if (period === "week") return "weekly_goal";
  if (period === "season") return "season_goal";
  return "custom";
}

function newIncentive(planId) {
  return {
    plan_id: planId,
    title: "",
    description: "",
    incentive_type: "season_goal",
    incentive_source: "personal",
    incentive_period: "season",
    target_value: "",
    target_date: "",
    start_date: "",
    end_date: "",
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
