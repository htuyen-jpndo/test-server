/**
 * JST billing periods anchored to the original start day.
 *
 * Adding one month to an already clamped end drifts: Jan 31 -> Feb 28 -> Mar 28.
 * Each end is instead "the anchor day in that month, or the month's last day":
 * Jan 31 -> Feb 28/29 -> Mar 31 -> Apr 30. Yearly Feb 29 returns on the next leap year.
 * Trial stays a flat 7 days.
 */

import { PaymentOrder } from "../models/paymentOrder.model.js";
import { parseJstDateTime } from "./jstDate.js";

function dateFromJstParts(year, month, day, hour, minute, second) {
  const utcMs = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  return new Date(utcMs);
}

export function jstPartsFromDate(date) {
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

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function shiftJstYearMonth(year, month, deltaMonths) {
  let y = year;
  let m = month + deltaMonths;
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return { year: y, month: m };
}

/** Same clock time, N months after `date`, clamped to the target month's last day. */
export function addMonthsInJst(date, months) {
  const p = jstPartsFromDate(date);
  const { year, month } = shiftJstYearMonth(p.year, p.month, months);
  const day = Math.min(p.day, lastDayOfMonth(year, month));
  return dateFromJstParts(year, month, day, p.hour, p.minute, p.second);
}

/** Same clock time, N years after `date`, clamped (Feb 29 -> Feb 28 in non-leap years). */
export function addYearsInJst(date, years) {
  const p = jstPartsFromDate(date);
  const year = p.year + years;
  const day = Math.min(p.day, lastDayOfMonth(year, p.month));
  return dateFromJstParts(year, p.month, day, p.hour, p.minute, p.second);
}

export function addDaysInJst(date, days) {
  const p = jstPartsFromDate(date);
  return dateFromJstParts(p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/**
 * J-Payment `ac1` (課金日指定). Allowed when the cycle is monthly or longer.
 * `1`–`30` are that day of the month. Day 31 is not a legal value; `99` means
 * the last day of the month, which matches an anchor day of 31.
 * Weekly trial (`actp=2`) must not send ac1 (ER576).
 * @returns {string|null}
 */
export function jpaymentAc1Code(anchor, planType) {
  if (planType !== "monthly" && planType !== "yearly") return null;
  const start = anchor instanceof Date ? anchor : parseJstDateTime(anchor);
  if (!start) return null;
  const day = jstPartsFromDate(start).day;
  if (day === 31) return "99";
  if (day >= 1 && day <= 30) return String(day);
  return null;
}

/** First paid segment. `anchor` is the period start (paidAt). */
export function buildFirstPeriod(planType, anchor) {
  const start = anchor instanceof Date ? anchor : parseJstDateTime(anchor);
  if (!start) return null;
  const end =
    planType === "yearly"
      ? addYearsInJst(start, 1)
      : planType === "trial"
        ? addDaysInJst(start, 7)
        : addMonthsInJst(start, 1);
  return { start, end };
}

/**
 * Next segment starting at `periodEndAt`.
 * Monthly/yearly ends are counted from `anchorAt` (original period start), not from
 * the previous clamped end. Without an anchor, falls back to adding one interval
 * to `periodEndAt` (that is the drifting behavior).
 */
export function buildNextPeriodFromPeriodEnd(planType, periodEndAt, anchorAt = null) {
  const start = parseJstDateTime(periodEndAt);
  if (!start) return null;
  const anchor = anchorAt != null ? parseJstDateTime(anchorAt) : null;
  if ((planType === "monthly" || planType === "yearly") && anchor) {
    const end = nextAnchoredPeriodEnd(anchor, start, planType);
    if (end) return { start, end };
  }
  const end =
    planType === "yearly"
      ? addYearsInJst(start, 1)
      : planType === "trial"
        ? addDaysInJst(start, 7)
        : addMonthsInJst(start, 1);
  return { start, end };
}

function nextAnchoredPeriodEnd(anchor, currentEnd, planType) {
  const a = jstPartsFromDate(anchor);
  const c = jstPartsFromDate(currentEnd);
  if (planType === "yearly") {
    const elapsed = c.year - a.year;
    const k = elapsed > 0 ? elapsed : 0;
    return addYearsInJst(anchor, k + 1);
  }
  const elapsed = (c.year - a.year) * 12 + (c.month - a.month);
  const k = elapsed > 0 ? elapsed : 0;
  return addMonthsInJst(anchor, k + 1);
}

/**
 * Original period start for this subscription chain (root row's periodStartAt).
 * Renewals copy a clamped periodStartAt, so the anchor has to come from the root.
 */
export async function resolveBillingAnchorDate(order, { transaction } = {}) {
  let current = order;
  const seen = new Set();
  for (let i = 0; i < 240 && current?.sourceOrderId && !seen.has(current.id); i += 1) {
    seen.add(current.id);
    const parent = await PaymentOrder.findByPk(current.sourceOrderId, {
      transaction,
      lock: transaction?.LOCK?.UPDATE,
    });
    if (!parent) break;
    current = parent;
  }
  return parseJstDateTime(current?.periodStartAt) || parseJstDateTime(order?.periodStartAt) || null;
}
