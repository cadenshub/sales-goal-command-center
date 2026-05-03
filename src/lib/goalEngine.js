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

export function buildCommandCenter(workspace) {
  if (!workspace?.plan) return null;
  const plan = workspace.plan;
  const settings = workspace.settings || {};
  const today = todayISO();
  const weekStartDay = Number(settings.default_week_start_day ?? 1);
  const entriesByDate = Object.fromEntries((workspace.salesEntries || []).map((entry) => [entry.date, entry]));
  const dayOverrides = Object.fromEntries((workspace.calendarDays || []).map((day) => [day.date, day]));
  const normalWorkdays = settings.normal_workdays || [1, 2, 3, 4, 5, 6];
  const seasonDates = datesBetween(plan.start_date, plan.end_date);
  const activeEnd = minISO(today, plan.end_date);
  const currentWeekStart = toISO(weekStart(parseISO(today), weekStartDay));
  const currentWeekEnd = toISO(weekEnd(parseISO(today), weekStartDay));
  const currentMonthStart = toISO(monthStart(parseISO(today)));
  const currentMonthEnd = toISO(monthEnd(parseISO(today)));
  const salesInRange = sumSales(plan.start_date, plan.end_date, entriesByDate);
  const outsideSales = (workspace.salesEntries || [])
    .filter((entry) => entry.date < plan.start_date || entry.date > plan.end_date)
    .reduce((sum, entry) => sum + Number(entry.sales_count || 0), 0);
  const completed =
    Number(plan.starting_sales || 0) + salesInRange + (plan.include_outside_range_sales ? outsideSales : 0);
  const remaining = Math.max(0, Number(plan.total_goal || 0) - completed);
  const futureStart = maxISO(today, plan.tracking_start_date || plan.start_date);
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
  const workedDates = seasonDates.filter((date) => historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate) > 0);
  const workedCapacity = workedDates.reduce(
    (sum, date) => sum + historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate),
    0,
  );
  const entrySalesInHistory = sumSales(plan.start_date, activeEnd, entriesByDate);
  const avgPerWorkedDay = workedCapacity > 0 ? entrySalesInHistory / workedCapacity : 0;
  const afterToday = toISO(addDays(parseISO(today), 1));
  const futureCapacity = afterToday <= plan.end_date ? sumCapacity(afterToday, plan.end_date, normalWorkdays, dayOverrides) : 0;
  const projectedFinish = completed + avgPerWorkedDay * futureCapacity;
  const currentWeek = getWeekRange(workspace, currentWeekStart, currentWeekEnd, plan.default_weekly_goal);
  const currentWeekActual = sumSales(currentWeek.week_start, currentWeek.week_end, entriesByDate);
  const currentWeekRemaining = Math.max(0, Number(currentWeek.weekly_goal || 0) - currentWeekActual);
  const currentWeekFutureStart = maxISO(today, currentWeek.week_start);
  const currentWeekCapacity =
    currentWeekFutureStart <= currentWeek.week_end
      ? sumCapacity(currentWeekFutureStart, currentWeek.week_end, normalWorkdays, dayOverrides)
      : 0;
  const requiredThisWeek = currentWeekCapacity > 0 ? currentWeekRemaining / currentWeekCapacity : 0;
  const todayCapacity = capacityForDate(today, normalWorkdays, dayOverrides);
  const salesNeededToday =
    today >= plan.start_date && today <= plan.end_date && todayCapacity > 0
      ? Math.max(0, requiredPerWorkday * todayCapacity - saleCount(today, entriesByDate))
      : 0;
  const dayPlans = seasonDates.map((date) =>
    buildDayPlan(date, {
      today,
      requiredPerWorkday,
      baselineDailyTarget: baselineCapacity > 0 ? Number(plan.total_goal || 0) / baselineCapacity : 0,
      normalWorkdays,
      dayOverrides,
      entriesByDate,
    }),
  );
  const bestDay = workedDates.reduce((best, date) => (saleCount(date, entriesByDate) > saleCount(best, entriesByDate) ? date : best), workedDates[0]);
  const worstDay = workedDates.reduce((worst, date) => (saleCount(date, entriesByDate) < saleCount(worst, entriesByDate) ? date : worst), workedDates[0]);
  const zeroSaleDays = workedDates.filter((date) => saleCount(date, entriesByDate) === 0).length;
  const currentStreak = getCurrentStreak(today, plan.start_date, normalWorkdays, dayOverrides, entriesByDate);
  const weeks = buildWeeks(workspace, weekStartDay, normalWorkdays, dayOverrides, entriesByDate);
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
    dayOverrides,
    dayPlans,
    weeks,
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
  const actual = Number(entry?.sales_count || 0);
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

function historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate) {
  if (date > today) return 0;
  const override = dayOverrides[date];
  if (override?.day_type === "off" || override?.include_in_calculations === false) return 0;
  if (override?.day_type === "missed") return 1;
  if (override) return Number(override.capacity_weight ?? 1);
  if (saleCount(date, entriesByDate) > 0) return 1;
  const parsed = parseISO(date);
  return parsed && normalWorkdays.includes(parsed.getDay()) ? 1 : 0;
}

function saleCount(date, entriesByDate) {
  return Number(entriesByDate[date]?.sales_count || 0);
}

function sumSales(start, end, entriesByDate) {
  return datesBetween(start, end).reduce((sum, date) => sum + saleCount(date, entriesByDate), 0);
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

function getCurrentStreak(today, seasonStart, normalWorkdays, dayOverrides, entriesByDate) {
  let streak = 0;
  for (let cursor = parseISO(today); toISO(cursor) >= seasonStart; cursor = addDays(cursor, -1)) {
    const date = toISO(cursor);
    const weight = historicalWeight(date, today, normalWorkdays, dayOverrides, entriesByDate);
    if (weight === 0) continue;
    if (saleCount(date, entriesByDate) > 0) streak += 1;
    else break;
  }
  return streak;
}

function getWeekRange(workspace, start, end, defaultGoal) {
  const match = (workspace.weeks || []).find((week) => start <= week.week_end && end >= week.week_start);
  return (
    match || {
      week_start: start,
      week_end: end,
      weekly_goal: defaultGoal,
      custom_goal_enabled: false,
      custom_range_enabled: false,
      range_label: "Current sales week",
    }
  );
}

function buildWeeks(workspace, weekStartDay, normalWorkdays, dayOverrides, entriesByDate) {
  const plan = workspace.plan;
  const ranges = [];
  let cursor = weekStart(parseISO(plan.start_date), weekStartDay);
  const seasonEnd = parseISO(plan.end_date);
  while (cursor <= seasonEnd) {
    const start = toISO(cursor);
    const end = toISO(weekEnd(cursor, weekStartDay));
    ranges.push(getWeekRange(workspace, start, end, plan.default_weekly_goal));
    cursor = addDays(cursor, 7);
  }

  const unique = new Map();
  [...ranges, ...(workspace.weeks || [])].forEach((week) => {
    unique.set(`${week.week_start}-${week.week_end}`, week);
  });

  return [...unique.values()]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((week) => {
      const actual = sumSales(week.week_start, week.week_end, entriesByDate);
      const remaining = Math.max(0, Number(week.weekly_goal || 0) - actual);
      const today = todayISO();
      const remainingStart = maxISO(today, week.week_start);
      const capacity = remainingStart <= week.week_end ? sumCapacity(remainingStart, week.week_end, normalWorkdays, dayOverrides) : 0;
      const requiredPerDay = capacity > 0 ? remaining / capacity : 0;
      const progress = Number(week.weekly_goal || 0) > 0 ? (actual / Number(week.weekly_goal || 0)) * 100 : 100;
      return {
        ...week,
        actual,
        remaining,
        remainingCapacity: capacity,
        requiredPerDay,
        progress,
        status: requiredPerDay > Number(workspace.plan.max_sales_per_day || 0) ? "Overloaded" : progress >= 100 ? "Ahead" : "Active",
      };
    });
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
  return { salesByDay, goalLine, weekly, projected: [{ name: "Projection", projected: completed, goal: plan.total_goal }] };
}
