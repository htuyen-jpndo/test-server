/**
 * JST-aligned period math (aligned with paymentCallback renewal segment).
 * Used for BANK_TRANSFER / FREE server-side auto-renew (no J-Payment).
 */

function dateFromJstParts(year, month, day, hour, minute, second) {
  const utcMs = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  return new Date(utcMs);
}

function jstPartsFromDate(date) {
  const jstMs = date.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    second: jst.getUTCSeconds(),
  };
}

function parseDateInputToDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;

  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/
  );
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4] ?? "0");
    const minute = Number(m[5] ?? "0");
    const second = Number(m[6] ?? "0");
    return dateFromJstParts(year, month, day, hour, minute, second);
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonthsInJst(date, months) {
  const p = jstPartsFromDate(date);
  return dateFromJstParts(p.year, p.month + months, p.day, p.hour, p.minute, p.second);
}

function addYearsInJst(date, years) {
  const p = jstPartsFromDate(date);
  return dateFromJstParts(p.year + years, p.month, p.day, p.hour, p.minute, p.second);
}

function addDaysInJst(date, days) {
  const p = jstPartsFromDate(date);
  return dateFromJstParts(p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/**
 * Next billing segment after current period end (same as recurring callback).
 * @param {string} planType monthly | yearly | trial
 * @param {Date|string} periodEndAt anchor = start of next segment
 * @returns {{ start: Date, end: Date } | null}
 */
export function buildNextPeriodFromPeriodEnd(planType, periodEndAt) {
  const start = parseDateInputToDate(periodEndAt);
  if (!start) return null;
  const end =
    planType === "yearly"
      ? addYearsInJst(start, 1)
      : planType === "trial"
        ? addDaysInJst(start, 7)
        : addMonthsInJst(start, 1);
  return { start, end };
}
