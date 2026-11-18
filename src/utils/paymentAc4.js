/**
 * Optional J-Payment 課金開始日-style anchor (request field `ac4`).
 * **Only used with `planType: trial`** in checkout/init; monthly/yearly keep the default period.
 * Date-only values are interpreted in Asia/Tokyo (same JST convention as payment periods).
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

function addDaysInJst(date, days) {
  const p = jstPartsFromDate(date);
  return dateFromJstParts(p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

export function getTodayJstStartForAc4(now = new Date()) {
  const p = jstPartsFromDate(now);
  return dateFromJstParts(p.year, p.month, p.day, 0, 0, 0);
}

export function getTomorrowJstStartForAc4(now = new Date()) {
  return addDaysInJst(getTodayJstStartForAc4(now), 1);
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string, jstDayStart: Date } | { ok: false, error: string }}
 */
export function parseAndNormalizeAc4(raw) {
  if (raw == null || raw === "") return { ok: false, error: "ac4 is empty" };
  const s = String(raw).trim();
  let y;
  let m;
  let d;
  const dashed = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const slashed = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const compact = s.match(/^(\d{8})$/);
  if (dashed) {
    y = Number(dashed[1]);
    m = Number(dashed[2]);
    d = Number(dashed[3]);
  } else if (slashed) {
    y = Number(slashed[1]);
    m = Number(slashed[2]);
    d = Number(slashed[3]);
  } else if (compact) {
    const c = compact[1];
    y = Number(c.slice(0, 4));
    m = Number(c.slice(4, 6));
    d = Number(c.slice(6, 8));
  } else {
    return { ok: false, error: "ac4 must be YYYY/MM/DD (J-Payment), YYYY-MM-DD, or YYYYMMDD" };
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { ok: false, error: "ac4 invalid" };
  }
  const jstDayStart = dateFromJstParts(y, m, d, 0, 0, 0);
  if (Number.isNaN(jstDayStart.getTime())) {
    return { ok: false, error: "ac4 invalid date" };
  }
  const p = jstPartsFromDate(jstDayStart);
  if (p.year !== y || p.month !== m || p.day !== d) {
    return { ok: false, error: "ac4 invalid calendar date" };
  }
  const value = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { ok: true, value, jstDayStart };
}

/** Parse + require calendar date on or after tomorrow JST (for “翌日課金” style tests). */
export function parseValidateAc4ForInit(raw, { now = new Date() } = {}) {
  const parsed = parseAndNormalizeAc4(raw);
  if (!parsed.ok) return parsed;
  const minStart = getTomorrowJstStartForAc4(now);
  if (parsed.jstDayStart.getTime() < minStart.getTime()) {
    return {
      ok: false,
      error: "ac4 must be on or after tomorrow (Asia/Tokyo calendar)",
    };
  }
  return { ok: true, value: parsed.value, jstDayStart: parsed.jstDayStart };
}

/** J-Payment link spec: `ac4` as YYYY/MM/DD (e.g. 2026/05/15), not YYYYMMDD. */
export function formatAc4ForJpaymentLink(ac4YyyyMmDd) {
  const p = parseAndNormalizeAc4(ac4YyyyMmDd);
  if (!p.ok) return null;
  const [yy, mm, dd] = p.value.split("-");
  return `${yy}/${mm}/${dd}`;
}

/**
 * When `ac4` was not stored on the row but `periodEndAt` was anchored to JST midnight (ac4 flow),
 * derive the same YYYY/MM/DD for the J-Payment form. Default trial +7d keeps wall-clock → rarely 00:00:00.
 */
export function formatAc4SlashFromTrialAc4StylePeriodEnd(periodEndAt) {
  if (periodEndAt == null) return null;
  const d = periodEndAt instanceof Date ? periodEndAt : new Date(periodEndAt);
  if (Number.isNaN(d.getTime())) return null;
  const p = jstPartsFromDate(d);
  if (p.hour !== 0 || p.minute !== 0 || p.second !== 0) return null;
  return `${p.year}/${String(p.month).padStart(2, "0")}/${String(p.day).padStart(2, "0")}`;
}

/**
 * First paid period when ac4 is set: access from paidAt until start of ac4 day (JST),
 * matching renewal anchor used by handleAutoRenewResultCallback (periodEndAt → next segment).
 */
export function buildFirstPaidPeriodAnchoredToAc4(paidAt, ac4YyyyMmDd) {
  const ac4p = parseAndNormalizeAc4(ac4YyyyMmDd);
  if (!ac4p.ok) return null;
  const start =
    paidAt instanceof Date
      ? paidAt
      : paidAt
        ? new Date(paidAt)
        : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  return {
    start,
    end: ac4p.jstDayStart,
  };
}
