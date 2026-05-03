import { addDays, todayISO, toISO, weekStart, weekEnd } from "./dates";

export function makeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function blankPlan() {
  const today = todayISO();
  const start = today;
  const end = toISO(addDays(new Date(), 89));
  return {
    plan: {
      id: makeId("plan"),
      name: "Spring Sales Command",
      start_date: start,
      end_date: end,
      tracking_start_date: today,
      total_goal: 100,
      starting_sales: 0,
      default_weekly_goal: 10,
      max_sales_per_day: 4,
      catchup_strategy: "balanced",
      include_outside_range_sales: false,
      date_range_notes: "",
      active: true,
    },
    settings: {
      normal_workdays: [1, 2, 3, 4, 5, 6],
      catchup_preference: "balanced",
      theme_preference: "system",
      default_week_start_day: 1,
    },
    weeks: [],
    goalPeriods: [],
    calendarDays: [],
    salesEntries: [],
    incentives: [],
    savedFilters: [],
  };
}

export function demoWorkspace() {
  const today = todayISO();
  const todayDate = new Date();
  const start = toISO(addDays(todayDate, -18));
  const end = toISO(addDays(todayDate, 72));
  const currentWeekStart = toISO(weekStart(todayDate, 1));
  const currentWeekEnd = toISO(weekEnd(todayDate, 1));

  return {
    plan: {
      id: "demo-plan",
      name: "Launch Season Command",
      start_date: start,
      end_date: end,
      tracking_start_date: start,
      total_goal: 120,
      starting_sales: 7,
      default_weekly_goal: 12,
      max_sales_per_day: 4,
      catchup_strategy: "balanced",
      include_outside_range_sales: false,
      date_range_notes: "Demo mode. Connect Supabase for permanent hosted saving.",
      active: true,
    },
    settings: {
      normal_workdays: [1, 2, 3, 4, 5, 6],
      catchup_preference: "balanced",
      theme_preference: "system",
      default_week_start_day: 1,
    },
    weeks: [
      {
        id: "week-current",
        plan_id: "demo-plan",
        week_start: currentWeekStart,
        week_end: currentWeekEnd,
        weekly_goal: 15,
        custom_goal_enabled: true,
        custom_range_enabled: false,
        range_label: "Current push week",
        notes: "A slightly bigger target for momentum.",
      },
      {
        id: "week-next",
        plan_id: "demo-plan",
        week_start: toISO(addDays(weekStart(todayDate, 1), 7)),
        week_end: toISO(addDays(weekEnd(todayDate, 1), 7)),
        weekly_goal: 18,
        custom_goal_enabled: true,
        custom_range_enabled: false,
        range_label: "Demo push week",
        notes: "Use this to test weekly overrides.",
      },
    ],
    goalPeriods: [
      {
        id: "sprint-1",
        plan_id: "demo-plan",
        title: "Mid-season sprint",
        period_type: "sprint",
        start_date: today,
        end_date: toISO(addDays(todayDate, 13)),
        target_sales: 24,
        priority: "high",
        active: true,
        notes: "Short-term sprint inside the season.",
      },
    ],
    calendarDays: [
      dayOverride(-2, "partial", 0.5, "Half day for appointments."),
      dayOverride(2, "big_push", 1.5, "Big push day."),
      dayOverride(5, "off", 0, "Planned recovery day."),
    ],
    salesEntries: [
      entry(-7, 2, "Solid follow-up day."),
      entry(-6, 0, "No-shows."),
      entry(-5, 3, "Referral helped."),
      entry(-4, 2, ""),
      entry(-3, 4, "Best day so far."),
      entry(-2, 1, "Half day."),
      entry(-1, 2, ""),
    ],
    incentives: [
      incentive("new-shoes", "New shoes", "20 sales reward", "sales_milestone", 20, 120),
      incentive("dinner", "Nice dinner", "50 sales milestone", "sales_milestone", 50, 180),
      incentive("trip", "Weekend trip", "Hit 100 sales", "sales_milestone", 100, 800),
      incentive("streak", "Five-day streak", "Keep the daily flame alive.", "streak", 5, 50),
      incentive("season", "Season goal prize", "Major reward when the season goal lands.", "season_goal", 120, 1200),
    ],
    savedFilters: [],
  };

  function entry(offset, count, notes) {
    return {
      id: makeId("sale"),
      plan_id: "demo-plan",
      date: toISO(addDays(todayDate, offset)),
      sales_count: count,
      notes,
    };
  }

  function dayOverride(offset, dayType, capacityWeight, notes) {
    return {
      id: makeId("day"),
      plan_id: "demo-plan",
      date: toISO(addDays(todayDate, offset)),
      day_type: dayType,
      capacity_weight: capacityWeight,
      planned_target: 0,
      custom_target: null,
      include_in_calculations: dayType !== "off",
      notes,
    };
  }

  function incentive(id, title, description, incentiveType, targetValue, rewardValue) {
    return {
      id,
      plan_id: "demo-plan",
      title,
      description,
      incentive_type: incentiveType,
      target_value: targetValue,
      target_date: "",
      related_goal_period_id: null,
      reward_value: rewardValue,
      status: "locked",
    };
  }
}
