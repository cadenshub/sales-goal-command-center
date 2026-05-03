import { supabase } from "./supabase";

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function ensureProfile(user) {
  const { error } = await supabase.from("users").upsert({ id: user.id, email: user.email });
  if (error) throw error;
}

export async function loadWorkspace(userId) {
  const { data: plan, error: planError } = await supabase
    .from("plans")
    .select("*")
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (planError) throw planError;
  if (!plan) return null;

  const [
    { data: settings, error: settingsError },
    { data: weeks, error: weeksError },
    { data: goalPeriods, error: goalPeriodsError },
    { data: calendarDays, error: calendarDaysError },
    { data: salesEntries, error: salesEntriesError },
    { data: timeBlockEntries, error: timeBlockEntriesError },
    { data: weeklyConfirmations, error: weeklyConfirmationsError },
    { data: incentives, error: incentivesError },
    { data: savedFilters, error: filtersError },
  ] = await Promise.all([
    supabase.from("settings").select("*").eq("plan_id", plan.id).maybeSingle(),
    supabase.from("weeks").select("*").eq("plan_id", plan.id).order("week_start"),
    supabase.from("goal_periods").select("*").eq("plan_id", plan.id).order("start_date"),
    supabase.from("calendar_days").select("*").eq("plan_id", plan.id).order("date"),
    supabase.from("sales_entries").select("*").eq("plan_id", plan.id).order("date"),
    supabase.from("time_block_entries").select("*").eq("plan_id", plan.id).order("date"),
    supabase.from("weekly_confirmations").select("*").eq("plan_id", plan.id).order("week_start"),
    supabase.from("incentives").select("*").eq("plan_id", plan.id).order("target_value"),
    supabase.from("saved_filters").select("*").eq("plan_id", plan.id).order("created_at"),
  ]);

  const errors = [
    settingsError,
    weeksError,
    goalPeriodsError,
    calendarDaysError,
    salesEntriesError,
    timeBlockEntriesError?.code === "42P01" ? null : timeBlockEntriesError,
    weeklyConfirmationsError?.code === "42P01" ? null : weeklyConfirmationsError,
    incentivesError,
    filtersError,
  ].filter(Boolean);
  if (errors.length) throw errors[0];

  return {
    plan,
    settings: settings || {
      plan_id: plan.id,
      normal_workdays: [1, 2, 3, 4, 5, 6],
      catchup_preference: "balanced",
      theme_preference: "system",
      default_week_start_day: 1,
      time_blocks_config: null,
    },
    weeks: weeks || [],
    goalPeriods: goalPeriods || [],
    calendarDays: calendarDays || [],
    salesEntries: salesEntries || [],
    timeBlockEntries: timeBlockEntries || [],
    weeklyConfirmations: weeklyConfirmations || [],
    incentives: incentives || [],
    savedFilters: savedFilters || [],
  };
}

export async function upsertTimeBlockEntries(entries) {
  if (!entries.length) return [];
  const { data, error } = await supabase
    .from("time_block_entries")
    .upsert(entries, { onConflict: "plan_id,date,block_key" })
    .select();
  if (error) throw error;
  return data || [];
}

export async function upsertWeeklyConfirmation(confirmation) {
  const { data, error } = await supabase
    .from("weekly_confirmations")
    .upsert(confirmation, { onConflict: "plan_id,week_start,week_end" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function createWorkspace(userId, draft) {
  const { plan, settings, weeks, goalPeriods, calendarDays, incentives } = draft;
  const planForInsert = { ...plan };
  delete planForInsert.id;
  await supabase.from("plans").update({ active: false }).eq("user_id", userId);
  const { data: createdPlan, error: planError } = await supabase
    .from("plans")
    .insert({ ...planForInsert, user_id: userId, active: true })
    .select()
    .single();
  if (planError) throw planError;
  const planId = createdPlan.id;

  const operations = [
    supabase.from("settings").insert({ ...settings, plan_id: planId }),
    ...(weeks?.length ? [supabase.from("weeks").insert(weeks.map((item) => ({ ...item, plan_id: planId })))] : []),
    ...(goalPeriods?.length
      ? [supabase.from("goal_periods").insert(goalPeriods.map((item) => ({ ...item, plan_id: planId })))]
      : []),
    ...(calendarDays?.length
      ? [supabase.from("calendar_days").insert(calendarDays.map((item) => ({ ...item, plan_id: planId })))]
      : []),
    ...(incentives?.length
      ? [supabase.from("incentives").insert(incentives.map((item) => ({ ...item, plan_id: planId })))]
      : []),
  ];
  const results = await Promise.all(operations);
  const error = results.find((result) => result.error)?.error;
  if (error) throw error;
  return loadWorkspace(userId);
}

export async function updatePlan(planId, changes) {
  const { data, error } = await supabase.from("plans").update(changes).eq("id", planId).select().single();
  if (error) throw error;
  return data;
}

export async function upsertSettings(settings) {
  const { data, error } = await supabase.from("settings").upsert(settings, { onConflict: "plan_id" }).select().single();
  if (error) throw error;
  return data;
}

export async function upsertSalesEntry(entry) {
  const { data, error } = await supabase
    .from("sales_entries")
    .upsert(entry, { onConflict: "plan_id,date" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function upsertCalendarDay(day) {
  const { data, error } = await supabase
    .from("calendar_days")
    .upsert(day, { onConflict: "plan_id,date" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function upsertWeek(week) {
  const { data, error } = week.id
    ? await supabase.from("weeks").update(week).eq("id", week.id).select().single()
    : await supabase.from("weeks").insert(week).select().single();
  if (error) throw error;
  return data;
}

export async function deleteWeek(id) {
  const { error } = await supabase.from("weeks").delete().eq("id", id);
  if (error) throw error;
}

export async function upsertGoalPeriod(period) {
  const { data, error } = period.id
    ? await supabase.from("goal_periods").update(period).eq("id", period.id).select().single()
    : await supabase.from("goal_periods").insert(period).select().single();
  if (error) throw error;
  return data;
}

export async function deleteGoalPeriod(id) {
  const { error } = await supabase.from("goal_periods").delete().eq("id", id);
  if (error) throw error;
}

export async function upsertIncentive(incentive) {
  const { data, error } = incentive.id
    ? await supabase.from("incentives").update(incentive).eq("id", incentive.id).select().single()
    : await supabase.from("incentives").insert(incentive).select().single();
  if (error) throw error;
  return data;
}

export async function deleteIncentive(id) {
  const { error } = await supabase.from("incentives").delete().eq("id", id);
  if (error) throw error;
}
