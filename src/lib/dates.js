export const DAY_MS = 24 * 60 * 60 * 1000;

export const weekdayOptions = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

export function todayISO() {
  return toISO(new Date());
}

export function toISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseISO(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function diffDays(start, end) {
  return Math.round((startOfDay(end) - startOfDay(start)) / DAY_MS);
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function datesBetween(startISO, endISO) {
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  if (!start || !end || end < start) return [];
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(toISO(cursor));
  }
  return dates;
}

export function weekStart(date, weekStartDay = 1) {
  const copy = startOfDay(date);
  const day = copy.getDay();
  const offset = (day - weekStartDay + 7) % 7;
  return addDays(copy, -offset);
}

export function weekEnd(date, weekStartDay = 1) {
  return addDays(weekStart(date, weekStartDay), 6);
}

export function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function monthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function minISO(a, b) {
  return a <= b ? a : b;
}

export function maxISO(a, b) {
  return a >= b ? a : b;
}

export function clampISO(value, min, max) {
  return maxISO(min, minISO(value, max));
}

export function formatDate(iso, options = {}) {
  const date = parseISO(iso);
  if (!date) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    weekday: options.weekday,
    month: options.month ?? "short",
    day: "numeric",
    year: options.year ?? "numeric",
  }).format(date);
}

export function formatRange(startISO, endISO) {
  return `${formatDate(startISO, { year: undefined })} - ${formatDate(endISO, { year: undefined })}`;
}

export function formatMonth(iso) {
  const date = parseISO(iso);
  if (!date) return "Not set";
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

export function number(value, digits = 0) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(safe);
}

export function percent(value) {
  return `${Math.max(0, Math.min(100, value || 0)).toFixed(0)}%`;
}
