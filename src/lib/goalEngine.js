import {
  addDays,
  clampISO,
  datesBetween,
  diffDays,
  maxISO,
  minISO,
  monthEnd,
  monthStart,
  parseISO,
  todayISO,
  toISO,
  weekEnd,
  weekStart,
} from "./dates";

export const dayTypes = {
  off: { label: "Off", weight: 0, color: "slate" },
  half: { label: "Half day", weight: 0.5, color: "amber" },
  normal: { label: "Normal", weight: 1, color: "blue" },
  big_push: { label: "Big push", weight: 1.5, color: "emerald" },
  missed: { label: "Missed", weight: 0, color: "red" },
  custom: { label: "Custom", weight: 1, color: "violet" },
};

export function getEffectiveWeeklyGoal(week, planOrDefaultGoal) {
  const defaultGoal =
    typeof planOrDefaultGoal === "object"
      ? Number(planOrDefaultGoal?.default_weekly_goal || 0)
      : Number(planOrDefaultGoal || 0);
  return week?.custom_goal_enabled ? Number(week.weekly_goal || 0) : defaultGoal;
}

export const defaultTimeBlocks = [
  {
    key: "morning",
    name: "Morning",
    start_time: "09:00",
    end_time: "12:00",
    active: true,
    is_break: false,
    capacity_weight: 1,
    target_share: 1,
  },
  {
    key: "break",
    name: "Break",
    start_time: "12:00",
    end_time: "13:00",
    active: false,
    is_break: true,
    capacity_weight: 0,
    target_share: 0,
  },
  {
    key: "afternoon",
    name: "Afternoon",
    start_time: "13:00",
    end_time: "16:00",
    active: true,
    is_break: false,
    capacity_weight: 1,
    target_share: 1,
  },
  {
    key: "evening",
    name: "Evening Push",
    start_time: "16:00",
    end_time: "20:00",
    active: true,
    is_break: false,
    capacity_weight: 1,
    target_share: 1,
  },
];

export function buildCommandCenter(workspace) {
  if (!workspace?.plan) return null;
  const plan = workspace.plan;
  const settings = workspace.settings || {};
  const today = todayISO();
  const weekStartDay = Number(settings.default_week_start_day ?? 1);
  const entriesByDate = Object.fromEntries((workspace.salesEntries || []).map((entry) => [entry.date, entry]));
  const timeBlockEntries = workspace.timeBlockEntries || [];
  const timeBlocksByDate = groupTimeBlocks(timeBlockEntries);
  const weeklyConfirmationsByRange = groupWeeklyConfirmations(workspace.weeklyConfirmations || []);
  const salesConfirmationsByDate = Object.fromEntries((workspace.salesConfirmations || []).map((item) => [item.date, item]));
  const dayOverrides = Object.fromEntries((workspace.calendarDays || []).map((day) => [day.date, day]));
  const normalWorkdays = settings.normal_workdays || [1, 2, 3, 4, 5, 6];
  const timeBlocksConfig = normalizeTimeBlocks(settings.time_blocks_config);
  const seasonDates = datesBetween(plan.start_date, plan.end_date);
  const trackingStart = maxISO(plan.start_date, plan.tracking_start_date || plan.start_date);
  const activeEnd = minISO(today, plan.end_date);
  const currentMonthStart = toISO(monthStart(parseISO(today)));
  const currentMonthEnd = toISO(monthEnd(parseISO(today)));
  const salesInRange = sumSales(plan.start_date, plan.end_date, entriesByDate, timeBlocksByDate);
  const outsideSales = (workspace.salesEntries || [])
    .filter((entry) => entry.date < plan.start_date || entry.date > plan.end_date)
    .reduce((sum, entry) => sum + Number(entry.sales_count || 0), 0);
  const completed =
    Number(plan.starting_sales || 0) + salesInRange + (plan.include_outside_range_sales ? outsideSales : 0);
  const remaining = Math.max(0, Number(plan.total_goal || 0) - completed);
  const futureStart = maxISO(today, trackingStart);
  const remainingWorkCapacity =
    futureStart <= plan.end_date
      ? sumCapacity(futureStart, plan.end_date, normalWorkdays, dayOverrides)
      : 0;
  const requiredPerWorkday = remainingWorkCapacity > 0 ? remaining / remainingWorkCapacity : 0;
  const baselineCapacity = sumBaseline(plan.start_date, plan.end_date, normalWorkdays, dayOverrides);
  const elapsedCapacity =
    today < plan.start_date
      ? 0
      : sumBaseline(plan.start_date, clampISO(activeEnd, plan.start_date, plan.end_date), normalWorkdays, dayOverrides);
  const expectedByToday = baselineCapacity > 0 ? (Number(plan.total_goal || 0) * elapsedCapacity) / baselineCapacity : 0;
  const aheadBehind = completed - expectedByToday;
  const paceStatus = getPaceStatus(completed, expectedByToday, remaining, remainingWorkCapacity, requiredPerWorkday, plan);
  const workedDates = seasonDates.filter((date) => historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate, timeBlocksByDate) > 0);
  const workedCapacity = workedDates.reduce(
    (sum, date) => sum + historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate, timeBlocksByDate),
    0,
  );
  const entrySalesInHistory = sumSales(plan.start_date, activeEnd, entriesByDate, timeBlocksByDate);
  const avgPerWorkedDay = workedCapacity > 0 ? entrySalesInHistory / workedCapacity : 0;
  const afterToday = toISO(addDays(parseISO(today), 1));
  const futureCapacity = afterToday <= plan.end_date ? sumCapacity(afterToday, plan.end_date, normalWorkdays, dayOverrides) : 0;
  const projectedFinish = completed + avgPerWorkedDay * futureCapacity;
  const weeks = buildWeeks(
    workspace,
    weekStartDay,
    normalWorkdays,
    dayOverrides,
    entriesByDate,
    timeBlocksByDate,
    weeklyConfirmationsByRange,
  );
  const currentWeek = getCurrentTrackedWeek(weeks, workspace, today, weekStartDay);
  const currentWeekStart = currentWeek.week_start;
  const currentWeekEnd = currentWeek.week_end;
  const currentWeekActual = sumSales(currentWeek.week_start, currentWeek.week_end, entriesByDate, timeBlocksByDate);
  const currentWeekRemaining = Math.max(0, Number(currentWeek.weekly_goal || 0) - currentWeekActual);
  const currentWeekFutureStart = maxISO(maxISO(today, trackingStart), currentWeek.week_start);
  const currentWeekCapacity =
    currentWeekFutureStart <= currentWeek.week_end
      ? sumCapacity(currentWeekFutureStart, currentWeek.week_end, normalWorkdays, dayOverrides)
      : 0;
  const requiredThisWeek = currentWeekCapacity > 0 ? currentWeekRemaining / currentWeekCapacity : 0;
  const todayCapacity = capacityForDate(today, normalWorkdays, dayOverrides);
  const salesNeededToday =
    today >= plan.start_date && today <= plan.end_date && todayCapacity > 0
      ? Math.max(0, requiredPerWorkday * todayCapacity - saleCount(today, entriesByDate, timeBlocksByDate))
      : 0;
  const dayPlanContext = {
    today,
    requiredPerWorkday,
    baselineDailyTarget: baselineCapacity > 0 ? Number(plan.total_goal || 0) / baselineCapacity : 0,
    normalWorkdays,
    dayOverrides,
    entriesByDate,
    timeBlocksByDate,
    timeBlocksConfig,
  };
  const dayPlans = seasonDates.map((date) => buildDayPlan(date, dayPlanContext));
  const todayPlan =
    dayPlans.find((day) => day.date === today) ||
    buildDayPlan(today, {
      ...dayPlanContext,
      requiredPerWorkday: 0,
      baselineDailyTarget: 0,
    });
  const bestDay = workedDates.reduce((best, date) => (saleCount(date, entriesByDate, timeBlocksByDate) > saleCount(best, entriesByDate, timeBlocksByDate) ? date : best), workedDates[0]);
  const worstDay = workedDates.reduce((worst, date) => (saleCount(date, entriesByDate, timeBlocksByDate) < saleCount(worst, entriesByDate, timeBlocksByDate) ? date : worst), workedDates[0]);
  const zeroSaleDays = workedDates.filter((date) => saleCount(date, entriesByDate, timeBlocksByDate) === 0).length;
  const currentStreak = getCurrentStreak(today, plan.start_date, normalWorkdays, dayOverrides, entriesByDate, timeBlocksByDate);
  const incentives = evaluateIncentives(workspace.incentives || [], {
    completed,
    currentStreak,
    currentWeekActual,
    totalGoal: Number(plan.total_goal || 0),
  });
  const nextIncentive = incentives
    .filter((item) => item.status !== "claimed" && item.progress < 100)
    .sort((a, b) => b.progress - a.progress)[0];
  const outsideRangeEntries = (workspace.salesEntries || []).filter(
    (entry) => entry.date < plan.start_date || entry.date > plan.end_date,
  );
  const goalRealism = getGoalRealism(requiredPerWorkday, plan.max_sales_per_day, remainingWorkCapacity);
  const catchup = buildCatchup({
    plan,
    aheadBehind,
    currentWeekRemaining,
    currentWeekCapacity,
    requiredPerWorkday,
    requiredThisWeek,
    remaining,
    remainingWorkCapacity,
  });
  const charts = buildCharts(dayPlans, weeks, completed, plan);

  return {
    today,
    plan,
    settings,
    entriesByDate,
    timeBlocksByDate,
    timeBlockEntries,
    timeBlocksConfig,
    dayOverrides,
    dayPlans,
    todayPlan,
    weeks,
    weeklyConfirmationsByRange,
    salesConfirmations: workspace.salesConfirmations || [],
    salesConfirmationsByDate,
    incentives,
    nextIncentive,
    currentWeek,
    currentWeekActual,
    currentWeekRemaining,
    currentWeekCapacity,
    requiredThisWeek,
    currentWeekStart,
    currentWeekEnd,
    currentMonthStart,
    currentMonthEnd,
    completed,
    remaining,
    salesInRange,
    outsideSales,
    outsideRangeEntries,
    remainingWorkCapacity,
    requiredPerWorkday,
    expectedByToday,
    aheadBehind,
    paceStatus,
    projectedFinish,
    avgPerWorkedDay,
    bestDay,
    worstDay,
    zeroSaleDays,
    currentStreak,
    salesNeededToday,
    baselineCapacity,
    workedCapacity,
    goalRealism,
    catchup,
    charts,
    daysRemaining: today <= plan.end_date ? diffDays(parseISO(today), parseISO(plan.end_date)) + 1 : 0,
  };
}

export function buildDayPlan(date, context) {
  const override = context.dayOverrides[date];
  const entry = context.entriesByDate[date];
  const capacity = capacityForDate(date, context.normalWorkdays, context.dayOverrides);
  const historical = date < context.today;
  const plannedTarget =
    override?.custom_target !== null && override?.custom_target !== undefined
      ? Number(override.custom_target)
      : date >= context.today
        ? context.requiredPerWorkday * capacity
        : context.baselineDailyTarget * capacity;
  const timeBlocks = buildTimeBlockPlan({
    date,
    dailyTarget: plannedTarget,
    entries: context.timeBlocksByDate[date] || [],
    config: context.timeBlocksConfig,
    now: new Date(),
  });
  const hasBlockEntries = (context.timeBlocksByDate[date] || []).length > 0;
  const actual = hasBlockEntries ? timeBlocks.totalActual : Number(entry?.sales_count || 0);
  const delta = actual - plannedTarget;
  const dayType = override?.day_type || (capacity === 0 ? "off" : "normal");
  const status = getDayStatus({ date, today: context.today, dayType, capacity, actual, plannedTarget });
  return {
    date,
    dayType,
    capacity,
    plannedTarget,
    customTarget: override?.custom_target,
    actual,
    delta,
    status,
    notes: entry?.notes || override?.notes || "",
    timeBlocks,
    include: override?.include_in_calculations !== false,
    isPast: historical,
    isToday: date === context.today,
    isFuture: date > context.today,
  };
}

export function capacityForDate(date, normalWorkdays, dayOverrides) {
  const override = dayOverrides[date];
  if (override?.include_in_calculations === false) return 0;
  if (override) return Number(override.capacity_weight ?? dayTypes[override.day_type]?.weight ?? 1);
  const parsed = parseISO(date);
  return parsed && normalWorkdays.includes(parsed.getDay()) ? 1 : 0;
}

function baselineCapacityForDate(date, normalWorkdays, dayOverrides) {
  const override = dayOverrides[date];
  if (override?.include_in_calculations === false || override?.day_type === "off") return 0;
  if (override?.day_type === "missed") return 1;
  if (override) return Number(override.capacity_weight ?? 1);
  const parsed = parseISO(date);
  return parsed && normalWorkdays.includes(parsed.getDay()) ? 1 : 0;
}

function historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate, timeBlocksByDate) {
  if (date > today) return 0;
  const override = dayOverrides[date];
  if (override?.day_type === "off" || override?.include_in_calculations === false) return 0;
  if (override?.day_type === "missed") return 1;
  if (override) return Number(override.capacity_weight ?? 1);
  if (saleCount(date, entriesByDate, timeBlocksByDate) > 0) return 1;
  const parsed = parseISO(date);
  return parsed && normalWorkdays.includes(parsed.getDay()) ? 1 : 0;
}

function saleCount(date, entriesByDate, timeBlocksByDate = {}) {
  const blockEntries = timeBlocksByDate[date] || [];
  if (blockEntries.length) return blockEntries.reduce((sum, entry) => sum + Number(entry.actual_sales || 0), 0);
  return Number(entriesByDate[date]?.sales_count || 0);
}

function sumSales(start, end, entriesByDate, timeBlocksByDate = {}) {
  return datesBetween(start, end).reduce((sum, date) => sum + saleCount(date, entriesByDate, timeBlocksByDate), 0);
}

function sumCapacity(start, end, normalWorkdays, dayOverrides) {
  return datesBetween(start, end).reduce((sum, date) => sum + capacityForDate(date, normalWorkdays, dayOverrides), 0);
}

function sumBaseline(start, end, normalWorkdays, dayOverrides) {
  return datesBetween(start, end).reduce((sum, date) => sum + baselineCapacityForDate(date, normalWorkdays, dayOverrides), 0);
}

function getPaceStatus(completed, expectedByToday, remaining, remainingCapacity, requiredPerWorkday, plan) {
  if (remaining <= 0) return { key: "ahead", label: "Complete", tone: "green" };
  if (remainingCapacity <= 0 || requiredPerWorkday > Number(plan.max_sales_per_day || 0)) {
    return { key: "critical", label: "Critical", tone: "red" };
  }
  if (expectedByToday <= 0) return { key: "on_track", label: "On track", tone: "blue" };
  const ratio = completed / expectedByToday;
  if (ratio >= 1.05) return { key: "ahead", label: "Ahead", tone: "green" };
  if (ratio >= 0.95) return { key: "on_track", label: "On track", tone: "blue" };
  if (ratio >= 0.8) return { key: "behind", label: "Behind", tone: "amber" };
  return { key: "critical", label: "Critical", tone: "red" };
}

function getDayStatus({ date, today, dayType, capacity, actual, plannedTarget }) {
  if (dayType === "off") return "Off";
  if (dayType === "missed") return "Missed";
  if (dayType === "big_push") return actual >= plannedTarget && date <= today ? "Ahead" : "Big push";
  if (capacity === 0) return "Off";
  if (date > today) return "Planned";
  if (plannedTarget <= 0) return actual > 0 ? "Ahead" : "On track";
  const ratio = actual / plannedTarget;
  if (ratio >= 1.05) return "Ahead";
  if (ratio >= 0.95) return "On track";
  if (ratio >= 0.65) return "Behind";
  return "Critical";
}

function getCurrentStreak(today, seasonStart, normalWorkdays, dayOverrides, entriesByDate, timeBlocksByDate) {
  let streak = 0;
  for (let cursor = parseISO(today); toISO(cursor) >= seasonStart; cursor = addDays(cursor, -1)) {
    const date = toISO(cursor);
    const weight = historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate, timeBlocksByDate);
    if (weight === 0) continue;
    if (saleCount(date, entriesByDate, timeBlocksByDate) > 0) streak += 1;
    else break;
  }
  return streak;
}

function getCurrentTrackedWeek(weeks, workspace, today, weekStartDay) {
  const plan = workspace.plan;
  const trackingStart = maxISO(plan.start_date, plan.tracking_start_date || plan.start_date);
  const anchor = today < trackingStart ? trackingStart : today > plan.end_date ? plan.end_date : today;
  const match = weeks.find((week) => week.week_start <= anchor && anchor <= week.week_end);
  if (match) return match;

  const start = toISO(weekStart(parseISO(anchor), weekStartDay));
  const end = toISO(weekEnd(parseISO(anchor), weekStartDay));
  return getWeekRange(workspace, start, end, plan.default_weekly_goal);
}

function getWeekRange(workspace, start, end, defaultGoal) {
  const savedWeeks = workspace.weeks || [];
  const exactMatch = savedWeeks.find((week) => week.week_start === start && week.week_end === end);
  const rangeMatch = savedWeeks.find(
    (week) => week.custom_range_enabled && start <= week.week_end && end >= week.week_start,
  );
  const match = exactMatch || rangeMatch;
  return (
    match
      ? { ...match, weekly_goal: getEffectiveWeeklyGoal(match, defaultGoal) }
      : {
          week_start: start,
          week_end: end,
          weekly_goal: defaultGoal,
          custom_goal_enabled: false,
          custom_range_enabled: false,
          range_label: "Current sales week",
        }
  );
}

function buildWeeks(
  workspace,
  weekStartDay,
  normalWorkdays,
  dayOverrides,
  entriesByDate,
  timeBlocksByDate,
  weeklyConfirmationsByRange,
) {
  const plan = workspace.plan;
  const savedWeeks = workspace.weeks || [];
  const ranges = [];
  const trackingStart = maxISO(plan.start_date, plan.tracking_start_date || plan.start_date);
  let cursor = weekStart(parseISO(trackingStart), weekStartDay);
  const seasonEnd = parseISO(plan.end_date);
  while (cursor <= seasonEnd) {
    const start = toISO(cursor);
    const end = toISO(weekEnd(cursor, weekStartDay));
    ranges.push(getWeekRange(workspace, start, end, plan.default_weekly_goal));
    cursor = addDays(cursor, 7);
  }

  const canonical = new Map(ranges.map((week) => [`${week.week_start}:${week.week_end}`, week]));
  savedWeeks.forEach((savedWeek) => {
    if (savedWeek.custom_range_enabled && !ranges.some((range) => weeksOverlap(range, savedWeek))) {
      canonical.set(`${savedWeek.week_start}:${savedWeek.week_end}`, {
        ...savedWeek,
        weekly_goal: getEffectiveWeeklyGoal(savedWeek, plan),
      });
    }
  });

  return [...canonical.values()]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((week) => {
      const actual = sumSales(week.week_start, week.week_end, entriesByDate, timeBlocksByDate);
      const weeklyGoal = getEffectiveWeeklyGoal(week, plan);
      const remaining = Math.max(0, weeklyGoal - actual);
      const today = todayISO();
      const remainingStart = maxISO(today, week.week_start);
      const capacity = remainingStart <= week.week_end ? sumCapacity(remainingStart, week.week_end, normalWorkdays, dayOverrides) : 0;
      const requiredPerDay = capacity > 0 ? remaining / capacity : 0;
      const progress = weeklyGoal > 0 ? (actual / weeklyGoal) * 100 : 100;
      const confirmation = weeklyConfirmationsByRange[`${week.week_start}:${week.week_end}`] || null;
      return {
        ...week,
        weekly_goal: weeklyGoal,
        actual,
        remaining,
        remainingCapacity: capacity,
        requiredPerDay,
        progress,
        confirmation,
        confirmedSales: confirmation ? Number(confirmation.confirmed_sales || 0) : null,
        pendingSales: confirmation ? Number(confirmation.pending_sales || 0) : Math.max(0, actual),
        status: requiredPerDay > Number(workspace.plan.max_sales_per_day || 0) ? "Overloaded" : progress >= 100 ? "Ahead" : "Active",
      };
    });
}

function weeksOverlap(a, b) {
  return a.week_start <= b.week_end && b.week_start <= a.week_end;
}

function groupWeeklyConfirmations(confirmations) {
  return confirmations.reduce((groups, item) => {
    groups[`${item.week_start}:${item.week_end}`] = item;
    return groups;
  }, {});
}

function evaluateIncentives(incentives, metrics) {
  return incentives.map((incentive) => {
    let current = metrics.completed;
    if (incentive.incentive_type === "streak") current = metrics.currentStreak;
    if (incentive.incentive_type === "weekly_goal") current = metrics.currentWeekActual;
    if (incentive.incentive_type === "season_goal") current = metrics.completed;
    const target = Number(incentive.target_value || metrics.totalGoal || 0);
    const progress = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    const achieved = progress >= 100;
    return {
      ...incentive,
      current,
      target,
      progress,
      status: incentive.status === "claimed" ? "claimed" : achieved ? "achieved" : progress > 0 ? "in_progress" : "locked",
    };
  });
}

function getGoalRealism(requiredPerWorkday, maxSalesPerDay, remainingCapacity) {
  if (remainingCapacity <= 0) return { key: "critical", label: "No remaining selling capacity" };
  if (requiredPerWorkday <= Number(maxSalesPerDay || 0)) return { key: "realistic", label: "Realistic" };
  return {
    key: "overloaded",
    label: `Needs ${requiredPerWorkday.toFixed(1)}/day, above your ${maxSalesPerDay}/day max`,
  };
}

function buildCatchup({
  plan,
  aheadBehind,
  currentWeekRemaining,
  currentWeekCapacity,
  requiredPerWorkday,
  requiredThisWeek,
  remaining,
  remainingWorkCapacity,
}) {
  const max = Number(plan.max_sales_per_day || 0);
  const withExtraDay = remainingWorkCapacity + 1;
  const paceWithExtraDay = withExtraDay > 0 ? remaining / withExtraDay : 0;
  const messages = [];
  if (aheadBehind >= 1) {
    messages.push(`You are ${aheadBehind.toFixed(1)} sales ahead. Your required daily pace is now ${requiredPerWorkday.toFixed(1)}.`);
    if (requiredPerWorkday < max * 0.65) messages.push("You have room to protect the lead or take a planned lighter day.");
  } else if (aheadBehind < -0.5) {
    messages.push(`You are ${Math.abs(aheadBehind).toFixed(1)} sales behind season pace.`);
    messages.push(`Without changing schedule, you need ${requiredPerWorkday.toFixed(1)} sales per remaining workday.`);
  } else {
    messages.push(`You are on track. Hold ${requiredPerWorkday.toFixed(1)} sales per workday.`);
  }
  if (currentWeekRemaining > 0 && currentWeekCapacity > 0) {
    messages.push(`This week needs ${requiredThisWeek.toFixed(1)} sales per remaining workday.`);
  }
  if (requiredPerWorkday > max) {
    messages.push(`Your max realistic day is ${max}, so add workdays, extend the season, or lower the target.`);
    messages.push(`Adding one extra workday drops season pace to ${paceWithExtraDay.toFixed(1)}/day.`);
  } else if (requiredPerWorkday > max * 0.8) {
    messages.push("The plan is tight. A big push day would create useful breathing room.");
  }
  return { messages, paceWithExtraDay };
}

function buildCharts(dayPlans, weeks, completed, plan) {
  const salesByDay = dayPlans.map((day) => ({
    date: day.date.slice(5),
    actual: day.actual,
    target: Number(day.plannedTarget.toFixed(2)),
  }));
  let running = Number(plan.starting_sales || 0);
  const goalLine = dayPlans.map((day, index) => {
    running += day.actual;
    const expected = ((index + 1) / Math.max(1, dayPlans.length)) * Number(plan.total_goal || 0);
    return { date: day.date.slice(5), actual: running, goal: Number(expected.toFixed(1)) };
  });
  const weekly = weeks.map((week) => ({
    label: week.range_label || week.week_start.slice(5),
    actual: week.actual,
    goal: Number(week.weekly_goal || 0),
  }));
  const blockTotals = new Map();
  dayPlans.forEach((day) => {
    day.timeBlocks.blocks.forEach((block) => {
      if (block.is_break) return;
      const current = blockTotals.get(block.name) || { block: block.name, actual: 0, target: 0 };
      current.actual += Number(block.actual || 0);
      current.target += Number(block.target || 0);
      blockTotals.set(block.name, current);
    });
  });
  return {
    salesByDay,
    goalLine,
    weekly,
    timeBlocks: [...blockTotals.values()].map((item) => ({
      ...item,
      actual: Number(item.actual.toFixed(1)),
      target: Number(item.target.toFixed(1)),
    })),
    projected: [{ name: "Projection", projected: completed, goal: plan.total_goal }],
  };
}

export function normalizeTimeBlocks(config) {
  if (!Array.isArray(config) || !config.length) return defaultTimeBlocks;
  const byKey = new Map(config.map((block) => [block.key, block]));
  const merged = defaultTimeBlocks.map((fallback) => ({ ...fallback, ...(byKey.get(fallback.key) || {}) }));
  config.forEach((block) => {
    if (!merged.some((item) => item.key === block.key)) merged.push(block);
  });
  return merged.map((block) => ({
    ...block,
    active: Boolean(block.active),
    is_break: Boolean(block.is_break),
    capacity_weight: Number(block.capacity_weight ?? 1),
    target_share: Math.max(0, Number(block.target_share ?? block.capacity_weight ?? 1)),
  }));
}

export function buildTimeBlockPlan({ date, dailyTarget, entries, config, now = new Date() }) {
  const blocks = normalizeTimeBlocks(config);
  const entryByKey = Object.fromEntries(entries.map((entry) => [entry.block_key, entry]));
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = todayISO();
  const isToday = date === today;
  const activeSelling = blocks.filter((block) => block.active && !block.is_break && block.target_share > 0);
  const totalShare = activeSelling.reduce((sum, block) => sum + Number(block.target_share || 0), 0) || 1;
  const originalTargets = Object.fromEntries(
    blocks.map((block) => [
      block.key,
      block.active && !block.is_break ? (Number(dailyTarget || 0) * Number(block.target_share || 0)) / totalShare : 0,
    ]),
  );
  const pastActual = blocks.reduce((sum, block) => {
    const entry = entryByKey[block.key];
    const actual = Number(entry?.actual_sales || 0);
    const isPast = date < today || (isToday && blockEndMinutes(block) <= nowMinutes);
    return sum + (isPast ? actual : 0);
  }, 0);
  const adjustableBlocks = blocks.filter((block) => {
    const entry = entryByKey[block.key];
    const isSkipped = entry?.status === "skipped" || entry?.include_in_calculations === false;
    const isFutureOrCurrent = date > today || (isToday && blockEndMinutes(block) > nowMinutes);
    return block.active && !block.is_break && !isSkipped && isFutureOrCurrent;
  });
  const remainingTarget = Math.max(0, Number(dailyTarget || 0) - pastActual);
  const remainingShare = adjustableBlocks.reduce((sum, block) => sum + Number(block.target_share || 0), 0) || 1;
  let roundedRemaining = Math.round(remainingTarget);

  const enriched = blocks.map((block) => {
    const entry = entryByKey[block.key] || {};
    const actual = Number(entry.actual_sales || 0);
    const isCurrent = isToday && nowMinutes >= blockStartMinutes(block) && nowMinutes < blockEndMinutes(block);
    const isPast = date < today || (isToday && blockEndMinutes(block) <= nowMinutes);
    const isFuture = date > today || (isToday && blockStartMinutes(block) > nowMinutes);
    const isSkipped = entry.status === "skipped" || entry.include_in_calculations === false;
    let target = Number(entry.target_sales ?? originalTargets[block.key] ?? 0);
    if (adjustableBlocks.some((item) => item.key === block.key)) {
      target = (remainingTarget * Number(block.target_share || 0)) / remainingShare;
      const rounded = Math.max(0, Math.round(target));
      target = roundedRemaining > 0 ? Math.min(roundedRemaining, rounded) : 0;
      roundedRemaining -= target;
    }
    const remaining = Math.max(0, target - actual);
    return {
      ...block,
      target,
      originalTarget: originalTargets[block.key] || 0,
      actual,
      remaining,
      notes: entry.notes || "",
      type_breakdown: normalizeSaleTypeBreakdown(entry.type_breakdown, actual),
      status: blockStatus({ block, isCurrent, isPast, isFuture, isSkipped, actual, target }),
      isCurrent,
      isPast,
      isFuture,
      minutesLeft: isCurrent ? Math.max(0, blockEndMinutes(block) - nowMinutes) : 0,
    };
  });

  const totalActual = enriched.reduce((sum, block) => sum + Number(block.actual || 0), 0);
  const currentBlock = enriched.find((block) => block.isCurrent) || null;
  const nextBlock = enriched.find((block) => !block.is_break && block.active && block.isFuture) || null;
  return {
    blocks: enriched,
    totalActual,
    totalTarget: Number(dailyTarget || 0),
    totalRemaining: Math.max(0, Number(dailyTarget || 0) - totalActual),
    currentBlock,
    nextBlock,
    message: timeBlockMessage({ dailyTarget, totalActual, currentBlock, nextBlock, blocks: enriched }),
  };
}

function groupTimeBlocks(entries) {
  return entries.reduce((groups, entry) => {
    groups[entry.date] ||= [];
    groups[entry.date].push(entry);
    return groups;
  }, {});
}

function normalizeSaleTypeBreakdown(value, fallbackActual = 0) {
  const source = typeof value === "string" ? safeJsonParse(value) : value;
  const doors = Math.max(0, Number(source?.doors || 0));
  const phone = Math.max(0, Number(source?.phone || 0));
  if (doors + phone > 0) return { doors, phone };
  return { doors: Math.max(0, Number(fallbackActual || 0)), phone: 0 };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function blockStartMinutes(block) {
  return toMinutes(block.start_time);
}

function blockEndMinutes(block) {
  return toMinutes(block.end_time);
}

function toMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function blockStatus({ block, isCurrent, isPast, isSkipped, actual, target }) {
  if (block.is_break) return isCurrent ? "Break" : "Transition";
  if (isSkipped) return "Skipped";
  if (isCurrent) return "Current";
  if (!isPast) return "Not started";
  if (actual >= target && target > 0) return actual > target ? "Ahead" : "Complete";
  if (actual > 0 && target <= 0) return "Ahead";
  return "Behind";
}

function timeBlockMessage({ dailyTarget, totalActual, currentBlock, nextBlock, blocks }) {
  if (totalActual >= Number(dailyTarget || 0) && Number(dailyTarget || 0) > 0) return "You already covered the day. Everything else is bonus.";
  const firstSelling = blocks.find((block) => block.active && !block.is_break);
  if (firstSelling && firstSelling.isPast && firstSelling.actual > firstSelling.originalTarget) return "Strong morning. Afternoon target lowered.";
  if (firstSelling && firstSelling.isPast && firstSelling.actual < firstSelling.originalTarget) return "Morning was light. Afternoon needs a push.";
  if (currentBlock?.is_break && nextBlock) return `${nextBlock.name} needs ${nextBlock.remaining.toFixed(0)} to keep the day on pace.`;
  if (currentBlock && !currentBlock.is_break) return `Hit ${currentBlock.remaining.toFixed(0)} before ${currentBlock.end_time} and the next block gets easier.`;
  if (nextBlock) return `${nextBlock.name} is next: ${nextBlock.remaining.toFixed(0)} sales keeps today moving.`;
  return "Day review: every extra sale lowers tomorrow's pace.";
}
