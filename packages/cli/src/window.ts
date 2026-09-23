/** Relative and explicit history window resolution (architecture section 10). */

export type ResolvedWindow = {
  /** Explicit ISO-8601 start timestamp. */
  windowStart: string;
  /** Explicit ISO-8601 end timestamp. */
  windowEnd: string;
};

const RELATIVE_PATTERN = /^(\d+)(mo|w|d|y)$/;

/**
 * Resolve a window specification to explicit dates at plan time.
 * "6mo" resolves NOW minus six months to NOW. "2024-01-01..2024-06-30" is used
 * as an explicit inclusive day range.
 */
export function resolveWindow(spec: string, now: Date = new Date()): ResolvedWindow {
  const trimmed = spec.trim();
  const explicit = trimmed.split("..");
  if (explicit.length === 2) {
    const start = parseDayStart(explicit[0]);
    const end = parseDayEnd(explicit[1]);
    return { windowStart: start.toISOString(), windowEnd: end.toISOString() };
  }
  const match = RELATIVE_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid window "${spec}": use <N>mo|w|d|y (e.g. 6mo) or <YYYY-MM-DD>..<YYYY-MM-DD>`
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const start = new Date(now);
  switch (unit) {
    case "mo":
      start.setUTCMonth(start.getUTCMonth() - amount);
      break;
    case "w":
      start.setUTCDate(start.getUTCDate() - amount * 7);
      break;
    case "d":
      start.setUTCDate(start.getUTCDate() - amount);
      break;
    case "y":
      start.setUTCFullYear(start.getUTCFullYear() - amount);
      break;
  }
  return { windowStart: start.toISOString(), windowEnd: now.toISOString() };
}

function parseDayStart(day: string): Date {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date "${day}"`);
  return date;
}

function parseDayEnd(day: string): Date {
  const date = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date "${day}"`);
  return date;
}
