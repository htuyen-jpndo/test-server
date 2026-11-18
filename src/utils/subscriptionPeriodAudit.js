/**
 * Read-only checks for subscription period rows.
 * Compares stored dates with the anchored JST billing calendar.
 * Does not talk to the database.
 */

import { parseAndNormalizeAc4 } from "./paymentAc4.js";
import { parseJstDateTime } from "./jstDate.js";
import {
  buildFirstPeriod,
  buildNextPeriodFromPeriodEnd,
  jstPartsFromDate,
} from "./subscriptionRenewalPeriod.js";

const NINE_HOURS_MS = 9 * 60 * 60 * 1000;

export function maskEmail(email) {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at <= 0) return "***";
  return `${raw.slice(0, 1)}***@${raw.slice(at + 1)}`;
}

export function formatJstDateTime(value) {
  const date = value instanceof Date ? value : parseJstDateTime(value);
  if (!date) return "";
  const p = jstPartsFromDate(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function formatDelta(ms) {
  if (ms == null || Number.isNaN(ms)) return "";
  if (ms === 0) return "0";
  const sign = ms > 0 ? "+" : "-";
  const abs = Math.abs(ms);
  if (abs % NINE_HOURS_MS === 0 && abs / NINE_HOURS_MS <= 2) {
    const hours = abs / (60 * 60 * 1000);
    return `${sign}${hours}h`;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (abs % dayMs === 0) return `${sign}${abs / dayMs}d`;
  const hours = Math.round(abs / (60 * 60 * 1000));
  if (hours > 0 && Math.abs(abs - hours * 60 * 60 * 1000) < 1000) return `${sign}${hours}h`;
  return `${sign}${Math.round(abs / 1000)}s`;
}

function asDate(value) {
  if (value == null || value === "") return null;
  return value instanceof Date ? (Number.isNaN(value.getTime()) ? null : value) : parseJstDateTime(value);
}

function jstDay(date) {
  return date ? jstPartsFromDate(date).day : null;
}

function isAutoRenewOn(value) {
  return value === true || value === 1 || value === "1";
}

function planLabel(order) {
  const account = order.accountType || "?";
  const plan = order.planType || "?";
  return `${account}_${plan}`;
}

function expectedPlanForActiveOrder(order, now) {
  if (!order) return "none";
  const end = parseJstDateTime(order.periodEndAt, { endOfDayForDateOnly: true });
  if (!end || end.getTime() <= now.getTime()) return "none";
  const accountType = order.accountType;
  const planType = order.planType;
  if (
    (accountType === "personal" || accountType === "company") &&
    (planType === "monthly" || planType === "yearly" || planType === "trial")
  ) {
    return `${accountType}_${planType}`;
  }
  return "none";
}

function trialAc4End(order) {
  if (order.planType !== "trial" || order.ac4 == null || String(order.ac4).trim() === "") return null;
  const parsed = parseAndNormalizeAc4(order.ac4);
  return parsed.ok ? parsed.jstDayStart : null;
}

function periodReasons(storedStart, storedEnd, expectedStart, expectedEnd, anchor) {
  const reasons = [];
  const startDelta = storedStart && expectedStart ? storedStart.getTime() - expectedStart.getTime() : null;
  const endDelta = storedEnd && expectedEnd ? storedEnd.getTime() - expectedEnd.getTime() : null;
  const shifted =
    (startDelta != null && Math.abs(startDelta) === NINE_HOURS_MS) ||
    (endDelta != null && Math.abs(endDelta) === NINE_HOURS_MS);
  if (shifted) reasons.push("timezone_shift_9h");

  const anchorDay = jstDay(anchor);
  const dayMismatch =
    (storedEnd && expectedEnd && jstDay(storedEnd) !== jstDay(expectedEnd)) ||
    (storedStart && expectedStart && jstDay(storedStart) !== jstDay(expectedStart));
  if (dayMismatch && anchorDay != null && anchorDay >= 29) reasons.push("month_end_drift");

  const mismatch = (startDelta != null && startDelta !== 0) || (endDelta != null && endDelta !== 0);
  if (mismatch && reasons.length === 0) reasons.push("period_mismatch");
  return { reasons, startDelta, endDelta };
}

function differenceText(startDelta, endDelta) {
  const parts = [];
  if (startDelta != null && startDelta !== 0) parts.push(`start ${formatDelta(startDelta)}`);
  if (endDelta != null && endDelta !== 0) parts.push(`end ${formatDelta(endDelta)}`);
  return parts.join("; ");
}

function chainOrders(orders) {
  const relevant = orders.filter(
    (order) =>
      (order.status === "paid" || order.status === "expired") &&
      order.periodStartAt &&
      order.planType
  );
  const byId = new Map(relevant.map((order) => [Number(order.id), order]));
  const parentOf = new Map();
  for (const order of relevant) {
    const parentId = Number(order.sourceOrderId);
    if (parentId && byId.has(parentId)) parentOf.set(Number(order.id), parentId);
  }
  const groups = new Map();
  for (const order of relevant) {
    const key = order.subscriptionId
      ? `sub:${order.subscriptionId}`
      : `root:${rootId(Number(order.id), parentOf)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  return [...groups.values()].map((list) =>
    list.sort((a, b) => {
      const at = asDate(a.periodStartAt)?.getTime() ?? 0;
      const bt = asDate(b.periodStartAt)?.getTime() ?? 0;
      return at - bt || Number(a.id) - Number(b.id);
    })
  );
}

function rootId(id, parentOf) {
  const seen = new Set();
  let current = id;
  while (parentOf.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parentOf.get(current);
  }
  return current;
}

/**
 * @param {{ orders: object[], users?: object[], now?: Date }} input
 * @returns {object[]} findings, one row per problem
 */
export function auditSubscriptionRows({ orders = [], users = [], now = new Date() } = {}) {
  const emailByUser = new Map(users.map((user) => [Number(user.id), user.email]));
  const planByUser = new Map(users.map((user) => [Number(user.id), user.subscriptionPlan || "none"]));
  for (const order of orders) {
    if (order.email && !emailByUser.has(Number(order.userId))) emailByUser.set(Number(order.userId), order.email);
    if (order.subscriptionPlan && !planByUser.has(Number(order.userId))) {
      planByUser.set(Number(order.userId), order.subscriptionPlan);
    }
  }

  const findings = [];
  const push = (order, extra) => {
    findings.push({
      userId: order?.userId ?? "",
      emailMasked: maskEmail(emailByUser.get(Number(order?.userId)) || order?.email),
      orderId: order?.id ?? "",
      plan: order ? planLabel(order) : "",
      periodStartAt: formatJstDateTime(order?.periodStartAt),
      periodEndAt: formatJstDateTime(order?.periodEndAt),
      expectedPeriodStartAt: extra.expectedPeriodStartAt || "",
      expectedPeriodEndAt: extra.expectedPeriodEndAt || "",
      difference: extra.difference || "",
      reason: extra.reason,
    });
  };

  for (const chain of chainOrders(orders)) {
    const anchor = asDate(chain[0].periodStartAt);
    let expectedStart = anchor;
    for (let index = 0; index < chain.length; index += 1) {
      const order = chain[index];
      let expectedEnd = null;
      if (index === 0) {
        expectedEnd = trialAc4End(order) || buildFirstPeriod(order.planType, anchor)?.end || null;
      } else {
        const next = buildNextPeriodFromPeriodEnd(order.planType, expectedStart, anchor);
        expectedStart = next?.start || expectedStart;
        expectedEnd = next?.end || null;
      }
      const storedStart = asDate(order.periodStartAt);
      const storedEnd = asDate(order.periodEndAt);
      if (!storedEnd) {
        push(order, { reason: "missing_period", expectedPeriodStartAt: formatJstDateTime(expectedStart), expectedPeriodEndAt: formatJstDateTime(expectedEnd) });
      } else {
        const judged = periodReasons(storedStart, storedEnd, expectedStart, expectedEnd, anchor);
        if (judged.reasons.length) {
          push(order, {
            reason: judged.reasons.join(","),
            difference: differenceText(judged.startDelta, judged.endDelta),
            expectedPeriodStartAt: formatJstDateTime(expectedStart),
            expectedPeriodEndAt: formatJstDateTime(expectedEnd),
          });
        }
      }
      if (expectedEnd) expectedStart = expectedEnd;
    }
  }

  for (const order of orders) {
    if (order.status !== "paid") continue;
    if (order.paymentMethod !== "CREDIT_CARD") continue;
    if (!isAutoRenewOn(order.autoRenew)) continue;
    if (order.recurringToken != null && String(order.recurringToken).trim() !== "") continue;
    push(order, { reason: "paid_card_autorenew_missing_acid" });
  }

  const latestPaidByUser = new Map();
  for (const order of orders) {
    if (order.status !== "paid" || order.userId == null) continue;
    const key = Number(order.userId);
    const prev = latestPaidByUser.get(key);
    const created = asDate(order.createdAt)?.getTime() ?? 0;
    const prevCreated = prev ? asDate(prev.createdAt)?.getTime() ?? 0 : -1;
    if (!prev || created > prevCreated || (created === prevCreated && Number(order.id) > Number(prev.id))) {
      latestPaidByUser.set(key, order);
    }
  }
  const userIds = new Set([...planByUser.keys(), ...latestPaidByUser.keys()]);
  for (const userId of userIds) {
    const stored = planByUser.get(userId) || "none";
    const active = latestPaidByUser.get(userId) || null;
    const expected = expectedPlanForActiveOrder(active, now);
    if (stored === expected) continue;
    push(active || { userId, id: "", planType: "", accountType: "" }, {
      reason: `subscription_plan_mismatch stored=${stored} expected=${expected}`,
    });
  }

  findings.sort((a, b) => {
    const user = Number(a.userId) - Number(b.userId);
    if (user) return user;
    const order = Number(a.orderId || 0) - Number(b.orderId || 0);
    if (order) return order;
    return String(a.reason).localeCompare(String(b.reason));
  });
  return findings;
}

export const AUDIT_CSV_COLUMNS = [
  "userId",
  "emailMasked",
  "orderId",
  "plan",
  "periodStartAt",
  "periodEndAt",
  "expectedPeriodStartAt",
  "expectedPeriodEndAt",
  "difference",
  "reason",
];

export function findingsToCsv(findings) {
  const esc = (value) => {
    const text = value == null ? "" : String(value);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const row of findings) {
    lines.push(AUDIT_CSV_COLUMNS.map((key) => esc(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function findingsToTable(findings) {
  if (!findings.length) return "no subscription period issues\n";
  const headers = AUDIT_CSV_COLUMNS;
  const widths = headers.map((key) => {
    const cap = key === "reason" ? 72 : 36;
    return Math.min(cap, Math.max(key.length, ...findings.map((row) => String(row[key] ?? "").length)));
  });
  const clip = (value, width) => {
    const text = String(value ?? "");
    return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
  };
  const line = (row) => headers.map((key, i) => clip(row[key], widths[i])).join("  ");
  return `${line(Object.fromEntries(headers.map((key) => [key, key])))}\n${findings.map((row) => line(row)).join("\n")}\n`;
}

/** Reject anything that is not a read or an explicit transaction control statement. */
export function assertReadOnlySql(sql) {
  const text = String(sql || "").trim();
  if (!/^(SELECT|SHOW|SET|START|BEGIN|COMMIT|ROLLBACK|DESCRIBE|EXPLAIN)\b/i.test(text)) {
    throw new Error(`Refusing non-read SQL in subscription audit: ${text.slice(0, 180)}`);
  }
}
