import crypto from "crypto";
import { Op } from "sequelize";
import { sequelize } from "../config/db.js";
import { PaymentOrder } from "../models/paymentOrder.model.js";
import { verifyJPaymentCallbackQuerySecret } from "../utils/paymentNotify.js";
import { toPaymentProfilePayload } from "../utils/paymentProfile.js";
import { refreshAndSyncUserSubscriptionState } from "../middlewares/subscription.middleware.js";
import { getMinOnlineChargeJpy, getPlanAmount, resolveBilledBaseForProration } from "../utils/paymentPricing.js";
import { PAYMENT_METHOD } from "../utils/paymentEnums.js";
import { toTimestampWithTimeZone } from "../utils/time.js";
import {
  buildFirstPaidPeriodAnchoredToAc4,
  formatAc4ForJpaymentLink,
  formatAc4SlashFromTrialAc4StylePeriodEnd,
  parseValidateAc4ForInit,
} from "../utils/paymentAc4.js";

function toIntOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** Parse amount from FE: amount | am | expectedAmount (comma-formatted strings supported). */
function parsePositiveAmount(body) {
  const raw = body.amount ?? body.am ?? body.expectedAmount;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i <= 0) return null;
  return i;
}

function buildOrderCod({ userId, accountType, planType }) {
  return `ORD_${userId}_${accountType}_${planType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildSubscriptionId(userId) {
  return `SUB_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const JPAY_LINK_URL = "https://credit.j-payment.co.jp/link/creditcard";
const JPAY_AUTO_CHARGE_STOP_URL = "https://credit.j-payment.co.jp/gateway/acsgate.aspx";
const TRANSIENT_ORDER_KEEP_MINUTES = 30;
const STOP_RETRY_DELAYS_MS = [1000, 3000, 5000];
const UPGRADE_RENEWAL_GRACE_WINDOW_MS = 5 * 60 * 1000;
const RECURRING_RESULT_RSTS = new Set(["1", "2", "3", "4", "5"]);
const LEGACY_IID_PLAN_MAP = {
  "0002yc": { planType: "yearly", accountType: "company" },
  "0002mc": { planType: "monthly", accountType: "company" },
  "0001yp": { planType: "yearly", accountType: "personal" },
  "0001mp": { planType: "monthly", accountType: "personal" },
};

async function cleanupTransientOrdersForUser(userId) {
  if (!userId) return;
  const now = Date.now();
  const keepFrom = new Date(now - TRANSIENT_ORDER_KEEP_MINUTES * 60 * 1000);
  await PaymentOrder.destroy({
    where: {
      userId,
      createdAt: { [Op.lt]: keepFrom },
      [Op.or]: [
        { status: { [Op.in]: ["pending", "failed"] } },
        // Abandoned checkout only (init marks stale pending → cancelled); keep paid+cancelled history.
        { status: "cancelled", paidAt: null },
      ],
    },
  });
}

function makeOpaqueToken(len = 24) {
  return crypto.randomBytes(len).toString("hex");
}

async function ensureResultToken(order, options = {}) {
  if (order.resultToken && order.resultTokenExpiresAt && new Date(order.resultTokenExpiresAt) > new Date()) {
    return order.resultToken;
  }
  const token = makeOpaqueToken(12);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10m
  await order.update({
    resultToken: token,
    resultTokenExpiresAt: expiresAt,
  }, options);
  return token;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFrontendReturnUrl() {
  return (process.env.PAYMENT_FRONTEND_RETURN_URL || "").trim();
}

function getBackendPublicBaseUrl(req) {
  const envBase = (process.env.BACKEND_PUBLIC_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}`;
}

function toDateOnlyString(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isDuplicateStopResponse(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return false;
  return s.includes("already") || s.includes("duplicate") || s.includes("処理済") || s.includes("既に");
}

/**
 * Stop legacy auto-charge by server-to-server API call.
 * Spec: POST https://credit.j-payment.co.jp/gateway/acsgate.aspx with aid, acid, cmd=1.
 */
async function stopLegacyAutoCharge({ aid, legacyForStop, source = "unknown", expectedUserId = null } = {}) {
  const legacyOrderId = legacyForStop?.legacyOrderId || null;
  const acid = String(legacyForStop?.acid || "").trim();
  const userId = legacyForStop?.userId || null;
  if (!aid || !acid || !legacyOrderId) return { attempted: false };

  const legacyOrder = await PaymentOrder.findByPk(legacyOrderId);
  if (!legacyOrder) {
    console.warn("[STOP_RECURRING] legacy order not found", { legacyOrderId, source });
    return { attempted: false, skipped: true, reason: "legacy_order_not_found" };
  }
  if (expectedUserId && Number(legacyOrder.userId) !== Number(expectedUserId)) {
    console.error("[STOP_RECURRING] user mismatch; abort stop", {
      source,
      action: "STOP_RECURRING",
      legacyOrderId,
      expectedUserId,
      actualUserId: legacyOrder.userId,
    });
    return { attempted: false, skipped: true, reason: "user_mismatch" };
  }
  if (legacyOrder.stopRequested) {
    console.log("[STOP_RECURRING] skip duplicate request", {
      source,
      legacyOrderId,
      userId: legacyOrder.userId || userId,
      acid: `${acid.slice(0, 4)}***${acid.slice(-2)}`,
      action: "STOP_RECURRING",
      reason: "already_requested",
    });
    return { attempted: false, skipped: true, reason: "already_requested" };
  }

  const body = new URLSearchParams({
    aid: String(aid).trim(),
    acid,
    cmd: "1",
  });

  let lastResult = null;
  for (let i = 0; i < STOP_RETRY_DELAYS_MS.length; i += 1) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAYS_MS[i]));
    }
    try {
      const resp = await fetch(JPAY_AUTO_CHARGE_STOP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const text = await resp.text();
      const responseSnippet = String(text || "").slice(0, 400);
      const hasApiError = !responseSnippet || responseSnippet.includes("ER");
      const duplicateStop = isDuplicateStopResponse(responseSnippet);
      const ok = (resp.ok && !hasApiError) || duplicateStop;
      lastResult = { attempted: true, ok, status: resp.status, responseSnippet };
      console.log("[STOP_RECURRING] attempt", {
        action: "STOP_RECURRING",
        source,
        attempt: i + 1,
        legacyOrderId,
        userId: legacyOrder.userId || userId,
        acid: `${acid.slice(0, 4)}***${acid.slice(-2)}`,
        result: lastResult,
      });
      if (ok) break;
    } catch (err) {
      lastResult = { attempted: true, ok: false, status: null, error: err?.message || String(err) };
      console.error("[STOP_RECURRING] attempt failed", {
        action: "STOP_RECURRING",
        source,
        attempt: i + 1,
        legacyOrderId,
        userId: legacyOrder.userId || userId,
        acid: `${acid.slice(0, 4)}***${acid.slice(-2)}`,
        result: lastResult,
      });
    }
  }

  if (lastResult?.ok) {
    await legacyOrder.update({
      stopRequested: true,
      stopRequestedAt: new Date(),
      renewFailureCode: null,
      renewNextRetryAt: null,
    });
    return lastResult;
  }

  await legacyOrder.update({
    renewFailureCode: "STOP_API_FAILED",
    renewNextRetryAt: toDateOnlyString(Date.now() + 24 * 60 * 60 * 1000),
  });
  return { ...(lastResult || { attempted: true, ok: false }), retryLater: true };
}

function isGatewayAmountMismatch(order, q) {
  const actualAmount = toIntOrNull(q.am);
  if (actualAmount == null || order.expectedAmount == null) return false;
  return actualAmount !== order.expectedAmount;
}

function hasGatewayIdentityMismatch(order, q) {
  const cod = q.cod != null ? String(q.cod).trim() : "";
  const uid = q.uid != null ? String(q.uid).trim() : "";
  if (cod && cod !== String(order.cod || "").trim()) return true;
  if (uid && uid !== String(order.uidToken || "").trim()) return true;
  return false;
}

function applyGatewayResultToOrder(order, q, options = {}) {
  if (order.status === "paid") {
    // idempotent: keep paid order immutable for callback retries
    return Promise.resolve(order);
  }

  const rst = q.rst != null ? String(q.rst).trim() : "";
  const identityMismatch = hasGatewayIdentityMismatch(order, q);
  const amountMismatch = rst === "1" && isGatewayAmountMismatch(order, q);
  const incomingStatus = rst === "1" && !amountMismatch && !identityMismatch ? "paid" : "failed";
  const status = incomingStatus;
  const paidAt = status === "paid" ? order.paidAt || new Date() : null;
  let paidPeriod = null;
  if (status === "paid") {
    const ac4Raw = String(order.ac4 || "").trim();
    if (ac4Raw) {
      const anchored = buildFirstPaidPeriodAnchoredToAc4(paidAt, ac4Raw);
      if (anchored && anchored.end.getTime() > anchored.start.getTime()) {
        paidPeriod = anchored;
      } else {
        console.warn("[PAYMENT] ac4 anchor invalid vs paidAt; falling back to default period", {
          cod: order.cod,
          ac4: ac4Raw,
        });
      }
    }
    if (!paidPeriod) {
      paidPeriod = buildPeriodFromPaidAt(order.planType, paidAt);
    }
  }
  const mismatchError = amountMismatch
    ? "AMOUNT_MISMATCH"
    : identityMismatch
      ? "IDENTITY_MISMATCH"
      : null;

  if (amountMismatch) {
    console.error({
      type: "PAYMENT_AMOUNT_MISMATCH",
      orderId: order.id,
      cod: order.cod,
      expected: order.expectedAmount,
      actual: toIntOrNull(q.am),
      gid: q.gid != null ? String(q.gid).trim() : null,
    });
  }
  if (identityMismatch) {
    console.error({
      type: "PAYMENT_IDENTITY_MISMATCH",
      orderId: order.id,
      codExpected: order.cod,
      codActual: q.cod != null ? String(q.cod).trim() : null,
      uidExpected: order.uidToken,
      uidActual: q.uid != null ? String(q.uid).trim() : null,
      gid: q.gid != null ? String(q.gid).trim() : null,
    });
  }

  return order.update({
    gid: q.gid != null ? String(q.gid).trim() : null,
    god: q.god != null ? String(q.god).trim() : null,
    rst,
    status,
    ec: mismatchError || (q.ec != null ? String(q.ec).trim() : null),
    ap: q.ap != null ? String(q.ap).trim() : null,
    am: toIntOrNull(q.am),
    tx: toIntOrNull(q.tx),
    sf: toIntOrNull(q.sf),
    ta: toIntOrNull(q.ta),
    rawParams: JSON.stringify(q),
    recurringToken: q.acid != null ? String(q.acid).trim() : order.recurringToken,
    paidAt,
    periodStartAt: paidPeriod ? paidPeriod.start : order.periodStartAt,
    periodEndAt: paidPeriod ? paidPeriod.end : order.periodEndAt,
  }, options);
}

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

/** Same calendar day next month; clamp to last day if target month is shorter (e.g. Jan 31 → Feb 28). */
function addMonthsInJst(date, months) {
  const p = jstPartsFromDate(date);
  const { year, month } = shiftJstYearMonth(p.year, p.month, months);
  const day = Math.min(p.day, lastDayOfMonth(year, month));
  return dateFromJstParts(year, month, day, p.hour, p.minute, p.second);
}

/** Same calendar day next year; clamp for leap-year edge (e.g. Feb 29 2024 → Feb 28 2025). */
function addYearsInJst(date, years) {
  const p = jstPartsFromDate(date);
  const year = p.year + years;
  const day = Math.min(p.day, lastDayOfMonth(year, p.month));
  return dateFromJstParts(year, p.month, day, p.hour, p.minute, p.second);
}

function addDaysInJst(date, days) {
  const p = jstPartsFromDate(date);
  return dateFromJstParts(p.year, p.month, p.day + days, p.hour, p.minute, p.second);

}

function buildPeriodFromPaidAt(planType, paidAt) {
  const start = parseDateInputToDate(paidAt);
  if (!start) return null;
  const end = planType === "yearly"
    ? addYearsInJst(start, 1)
    : planType === "trial"
      ? addDaysInJst(start, 7)
      : addMonthsInJst(start, 1);
  return { start, end };
}

function recurringCycleCodeFromPlan(planType) {
  if (planType === "trial") return "2";
  return planType === "yearly" ? "8" : "4";
}

function buildRecurringRenewalCod(sourceOrder, gid) {
  return `ORD_${sourceOrder.userId}_${sourceOrder.accountType}_${sourceOrder.planType}_AUTO_${String(gid || Date.now())}`;
}

function asValidDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeCallbackCod(rawCod) {
  const cod = String(rawCod || "").trim();
  if (!cod) return "";
  // Some merchant settings append "(半角)" etc. Keep only the original cod prefix.
  const m = cod.match(/^ORD_[A-Za-z0-9_]+/);
  return m ? m[0] : cod;
}

function parsePlanType(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "monthly" || s === "month") return "monthly";
  if (s === "yearly" || s === "year" || s === "annual") return "yearly";
  if (s === "trial" || s === "week" || s === "weekly") return "trial";
  return null;
}

function parseAccountType(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "personal" || s === "individual") return "personal";
  if (s === "company" || s === "corporate" || s === "business") return "company";
  return null;
}

function parseLegacyIidPlan(rawIid) {
  const iid = String(rawIid || "").trim().toLowerCase();
  if (!iid) return null;
  return LEGACY_IID_PLAN_MAP[iid] || null;
}

function parseDateInputToLocalDate(raw) {
  return parseDateInputToDate(raw);
}

function diffDays(start, end) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / DAY_MS));
}

/** Mốc 0:00 cùng hệ tọa độ với period* đã parse (JST) — tránh lệch ngày với getTodayLocalStart() theo server TZ. */
function getTodayJstStart() {
  const p = jstPartsFromDate(new Date());
  return dateFromJstParts(p.year, p.month, p.day, 0, 0, 0);
}

async function buildUpgradePricingContext({ userId, planType, accountType, targetAmount }) {
  const currentActiveOrder = await PaymentOrder.findOne({
    where: {
      userId,
      status: "paid",
    },
    order: [["paidAt", "DESC"], ["createdAt", "DESC"]],
  });
  if (!currentActiveOrder) return null;

  // Consider this an "upgrade" only when plan/accountType differs from the current active package.
  const isDifferentPlan =
    currentActiveOrder.planType !== planType || currentActiveOrder.accountType !== accountType;
  if (!isDifferentPlan) return null;

  const today = getTodayJstStart();
  const periodStart = parseDateInputToLocalDate(currentActiveOrder.periodStartAt);
  const periodEnd = parseDateInputToLocalDate(currentActiveOrder.periodEndAt);
  if (!periodStart || !periodEnd || today.getTime() >= periodEnd.getTime()) return null;
  const now = new Date();
  const renewalRiskFrom = new Date(periodEnd.getTime() - UPGRADE_RENEWAL_GRACE_WINDOW_MS);
  if (now.getTime() >= renewalRiskFrom.getTime()) {
    return {
      blockedUpgradeNearRenewal: true,
      sourceOrderId: currentActiveOrder.id,
      sourcePlanType: currentActiveOrder.planType,
      sourceAccountType: currentActiveOrder.accountType,
      nextBillingAt: periodEnd,
      graceWindowMs: UPGRADE_RENEWAL_GRACE_WINDOW_MS,
    };
  }

  const totalDays = diffDays(periodStart, periodEnd);
  if (totalDays <= 0) return null;

  // Còn lại trong kỳ: từ max(hôm nay, bắt đầu kỳ) → hết kỳ (cùng trục thời gian với JST)
  const rangeStart = today.getTime() > periodStart.getTime() ? today : periodStart;
  if (rangeStart.getTime() >= periodEnd.getTime()) return null;

  let remainingDays = diffDays(rangeStart, periodEnd);
  remainingDays = Math.min(remainingDays, totalDays);
  if (remainingDays <= 0) return null;

  const currentPlanAmount = resolveBilledBaseForProration(currentActiveOrder);
  if (currentPlanAmount == null || currentPlanAmount <= 0) return null;

  // Tối đa một lần phí gói cũ (một kỳ); tránh tỷ lệ >1 vì lệch TZ / cạnh mốc
  const rawUnused = Math.round((currentPlanAmount * remainingDays) / totalDays);
  const unusedValue = Math.min(currentPlanAmount, Math.max(0, rawUnused));
  const isDowngrade = targetAmount < currentPlanAmount;
  const appliedCredit = unusedValue;
  const rawChargeAmount = targetAmount - appliedCredit;
  // No card refund: if credit > target, final charge is 0.
  const expectedAmount = Math.max(0, rawChargeAmount);
  const nonRefundedCredit = rawChargeAmount < 0 ? Math.abs(rawChargeAmount) : 0;

  return {
    mode: isDowngrade ? "plan_change_prorate_no_refund" : "plan_upgrade_prorate",
    sourceOrderId: currentActiveOrder.id,
    sourcePlanType: currentActiveOrder.planType,
    sourceAccountType: currentActiveOrder.accountType,
    sourcePlanAmount: currentPlanAmount,
    targetPlanType: planType,
    targetAccountType: accountType,
    targetAmount,
    isDowngrade,
    totalDays,
    remainingDays,
    unusedValue,
    appliedCredit,
    nonRefundedCredit,
    expectedAmount,
  };
}

async function handleAutoRenewResultCallback(order, q, transaction) {
  const rst = String(q.rst || "").trim();
  if (!RECURRING_RESULT_RSTS.has(rst)) {
    return order;
  }
  const recurringToken = q.acid != null ? String(q.acid).trim() : "";
  if (!recurringToken) {
    console.warn("[RECURRING CALLBACK] missing acid, ignored", { gid: q.gid ?? null, rst });
    return order;
  }
  const activeSubscription = await PaymentOrder.findOne({
    where: {
      recurringToken,
      status: "paid",
      autoRenew: true,
      cancelledAt: null,
    },
    order: [["periodEndAt", "DESC"], ["createdAt", "DESC"], ["id", "DESC"]],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (!activeSubscription) {
    console.warn("[RECURRING CALLBACK] ignore legacy/non-active subscription", {
      acid: `${recurringToken.slice(0, 4)}***${recurringToken.slice(-2)}`,
      gid: q.gid ?? null,
      rst,
    });
    return order;
  }
  if (Number(activeSubscription.userId) !== Number(order.userId)) {
    console.error("[RECURRING CALLBACK] acid-user mismatch, ignored", {
      incomingOrderId: order.id,
      incomingUserId: order.userId,
      matchedOrderId: activeSubscription.id,
      matchedUserId: activeSubscription.userId,
      acid: `${recurringToken.slice(0, 4)}***${recurringToken.slice(-2)}`,
    });
    return order;
  }
  if (activeSubscription.id !== order.id) {
    order = activeSubscription;
  }
  const incomingGid = q.gid != null ? String(q.gid).trim() : "";
  const currentGid = String(order?.gid || "").trim();
  // Initial checkout callback retries can include acid; if gid is unchanged, this is idempotent
  // for the same payment and must not create a renewal order.
  if (order.status === "paid" && incomingGid && currentGid && incomingGid === currentGid) {
    return order;
  }
  // If this subscription was already replaced/upgraded, ignore recurring callbacks.
  if (order.autoRenew === false) {
    await order.update(
      {
        rawParams: JSON.stringify(q),
        renewLastAttemptAt: new Date(),
      },
      { transaction }
    );
    return order;
  }

  const normalizedRecurringToken = recurringToken || null;
  const gid = q.gid != null ? String(q.gid).trim() : null;
  const ec = q.ec != null ? String(q.ec).trim() : null;
  const paidAmount = toIntOrNull(q.am);

  await order.update(
    {
      recurringToken: recurringToken || order.recurringToken,
      renewFailureCode: rst === "1" ? null : ec || `AUTO_RENEW_RST_${rst}`,
      rawParams: JSON.stringify(q),
      renewLastAttemptAt: new Date(),
      renewRetryCount: rst === "1" ? 0 : Number(order.renewRetryCount || 0) + 1,
      autoRenew: rst === "1" ? order.autoRenew : false,
      status: rst === "4" ? "cancelled" : order.status,
      cancelledAt: rst === "4" ? new Date() : order.cancelledAt,
    },
    { transaction }
  );

  if (rst !== "1") {
    return order;
  }

  const subscriptionId = order.subscriptionId || buildSubscriptionId(order.userId);
  if (!order.subscriptionId) {
    await order.update({ subscriptionId }, { transaction });
  }

  const latestOrder = await PaymentOrder.findOne({
    where: {
      subscriptionId,
      recurringToken: normalizedRecurringToken || order.recurringToken,
      status: { [Op.in]: ["paid", "expired"] },
    },
    order: [["periodEndAt", "DESC"], ["createdAt", "DESC"], ["id", "DESC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const sourceOrder = latestOrder || order;
  const period = buildPeriodFromPaidAt(sourceOrder.planType, asValidDate(sourceOrder.periodEndAt) || new Date());
  if (!period) return order;

  const existingByGid = gid
    ? await PaymentOrder.findOne({
      where: { gid, sourceOrderId: sourceOrder.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    : null;
  if (existingByGid) return existingByGid;
  const existingByAcidPeriod = await PaymentOrder.findOne({
    where: {
      recurringToken: normalizedRecurringToken || sourceOrder.recurringToken,
      renewalForPeriodEndAt: sourceOrder.periodEndAt,
      status: "paid",
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (existingByAcidPeriod) return existingByAcidPeriod;

  const renewalOrder = await PaymentOrder.create(
    {
      cod: buildRecurringRenewalCod(sourceOrder, gid),
      userId: sourceOrder.userId,
      paymentMethod: sourceOrder.paymentMethod ?? PAYMENT_METHOD.CREDIT_CARD,
      planType: sourceOrder.planType,
      accountType: sourceOrder.accountType,
      iid: sourceOrder.iid || null,
      expectedAmount: getPlanAmount(sourceOrder.planType, sourceOrder.accountType) ?? sourceOrder.expectedAmount,
      autoRenew: sourceOrder.autoRenew,
      subscriptionId,
      recurringToken: normalizedRecurringToken || sourceOrder.recurringToken,
      sourceOrderId: sourceOrder.id,
      renewalForPeriodEndAt: sourceOrder.periodEndAt,
      periodStartAt: period.start,
      periodEndAt: period.end,
      status: "paid",
      paidAt: new Date(),
      gid,
      god: q.god != null ? String(q.god).trim() : null,
      rst,
      ec,
      am: paidAmount ?? sourceOrder.expectedAmount ?? null,
      tx: toIntOrNull(q.tx),
      sf: toIntOrNull(q.sf),
      ta: toIntOrNull(q.ta),
      rawParams: JSON.stringify(q),
    },
    { transaction }
  );

  await sourceOrder.update(
    {
      status: "expired",
      renewFailureCode: null,
      renewNextRetryAt: null,
      renewLastAttemptAt: new Date(),
    },
    { transaction }
  );

  return renewalOrder;
}

/**
 * Supersede other paid rows for this user.
 * Returns legacy `acid` / `tid` pair for server-side J-Payment stop API.
 */
async function deactivateOtherPaidSubscriptions(userId, keepOrderId, transaction) {
  if (!userId || !keepOrderId) {
    return { legacy: null };
  }
  const oldPaidOrders = await PaymentOrder.findAll({
    where: {
      userId,
      status: "paid",
      id: { [Op.ne]: keepOrderId },
    },
    // Pick latest paid package(s) first: upgrade should stop the most recent active legacy subscription.
    order: [["createdAt", "DESC"]],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (!oldPaidOrders.length) {
    return { legacy: null };
  }

  const withToken = oldPaidOrders.filter((o) => String(o?.recurringToken || "").trim());
  const withTokenAndGid = withToken.filter((o) => String(o?.gid || "").trim());
  // J-Payment stop often needs acid + tid pair from the currently replaced subscription.
  // oldPaidOrders are DESC by createdAt, so index 0 is the latest legacy package.
  const primary = withTokenAndGid[0] || withToken[0] || null;
  if (withToken.length > 1) {
    console.warn("[PAYMENT] multiple legacy paid orders with recurringToken; pick token+gid if any", {
      userId,
      keepOrderId,
      chosenOrderId: primary?.id,
      orderIds: withToken.map((o) => o.id),
    });
  }
  if (primary && !String(primary.gid || "").trim()) {
    console.warn("[PAYMENT] legacy order has recurringToken but no gid (tid); J-Payment stop may require tid", {
      userId,
      orderId: primary.id,
    });
  }

  const legacy = primary
    ? {
        acid: String(primary.recurringToken).trim(),
        tid: String(primary.gid || "").trim(),
        legacyOrderId: primary.id,
      }
    : null;

  if (legacy) {
    const acidMasked = `${legacy.acid.slice(0, 4)}***${legacy.acid.slice(-2)}`;
    console.log("[PAYMENT] selected legacy stop pair", {
      userId,
      keepOrderId,
      legacyOrderId: legacy.legacyOrderId,
      tid: legacy.tid || null,
      acidMasked,
    });
  }

  await PaymentOrder.update(
    {
      autoRenew: false,
      status: "cancelled",
      cancelledAt: new Date(),
      renewFailureCode: "SUPERSEDED_BY_NEW_SUBSCRIPTION",
      renewNextRetryAt: null,
    },
    {
      where: {
        userId,
        status: "paid",
        id: { [Op.ne]: keepOrderId },
      },
      transaction,
    }
  );
  return { legacy };
}

/**
 * Fallback for callback retries/out-of-order deliveries:
 * resolve legacy stop candidate even when current order is already paid.
 */
async function findLegacyStopCandidate(userId, keepOrderId, incomingAcid, transaction) {
  if (!userId || !keepOrderId) return null;
  const normalizedIncomingAcid = String(incomingAcid || "").trim();
  const candidate = await PaymentOrder.findOne({
    where: {
      userId,
      id: { [Op.ne]: keepOrderId },
      recurringToken: { [Op.ne]: null },
      [Op.or]: [
        { status: "paid" },
        { renewFailureCode: "SUPERSEDED_BY_NEW_SUBSCRIPTION" },
      ],
    },
    order: [["updatedAt", "DESC"], ["createdAt", "DESC"]],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (!candidate) return null;

  const acid = String(candidate.recurringToken || "").trim();
  if (!acid) return null;
  // If same acid as incoming checkout, this is not an old subscription to stop.
  if (normalizedIncomingAcid && acid === normalizedIncomingAcid) return null;

  return {
    acid,
    tid: String(candidate.gid || "").trim(),
    legacyOrderId: candidate.id,
    userId: candidate.userId,
  };
}

function maskHeaders(headers) {
  const h = { ...(headers || {}) };
  if (h.authorization) h.authorization = "***masked***";
  if (h.cookie) h.cookie = "***masked***";
  return h;
}

function isVerbosePaymentLogEnabled() {
  const raw = String(process.env.PAYMENT_VERBOSE_LOGS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function logPaymentCallbackSnapshot(req) {
  const q = req.query || {};
  const summary = {
    at: new Date().toISOString(),
    method: req.method,
    originalUrl: req.originalUrl,
    ip: req.ip,
    userAgent: req.headers["user-agent"] || null,
    query: {
      gid: q.gid ?? null,
      rst: q.rst ?? null,
      cod: q.cod ?? null,
      uid: q.uid ?? null,
      am: q.am ?? null,
      acid: q.acid ?? null,
    },
  };
  console.log("[PAYMENT CALLBACK SNAPSHOT]", summary);

  if (!isVerbosePaymentLogEnabled()) return;

  const snapshot = {
    at: new Date().toISOString(),
    method: req.method,
    originalUrl: req.originalUrl,
    ip: req.ip,
    xForwardedFor: req.headers["x-forwarded-for"] || null,
    userAgent: req.headers["user-agent"] || null,
    headers: maskHeaders(req.headers),
    query: req.query || {},
    body: req.body || {},
  };

  console.log("========== [PAYMENT CALLBACK SNAPSHOT VERBOSE] ==========");
  console.log(JSON.stringify(snapshot, null, 2));
  console.log("=================================================");
}

/**
 * FE calls this before redirecting to J-Payment form to create order code (cod) and save package info.
 * Body: { planType, accountType, autoRenew?, amount? | am? | expectedAmount?, ac4? }
 * Optional `ac4` (YYYY/MM/DD per J-Payment spec; also accepts YYYY-MM-DD or YYYYMMDD). On/after tomorrow JST; **trial only** — sent to J-Payment as `YYYY/MM/DD`; first billing period ends at that JST day start.
 * Always create orders with paymentMethod = CREDIT_CARD. BANK_TRANSFER / FREE are admin-only updates (PATCH user payment).
 */
export async function initPaymentOrder(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};
    const legacyByIid = parseLegacyIidPlan(body.iid);
    const planType = parsePlanType(body.planType ?? body.plan) || legacyByIid?.planType || null;
    const accountType =
      parseAccountType(body.accountType ?? body.customerType) || legacyByIid?.accountType || null;
    if (!planType) {
      return res.status(400).json({ error: "planType must be monthly, yearly, or trial" });
    }
    if (!accountType) {
      return res.status(400).json({ error: "accountType must be personal or company" });
    }
    if (planType === "trial" && accountType !== "personal") {
      return res.status(400).json({ error: "trial plan only supports personal accountType" });
    }

    const now = new Date();

    let ac4Value = null;
    let ac4JstDayStart = null;
    const ac4Body = body.ac4;
    const hasAc4 =
      ac4Body != null && String(ac4Body).trim() !== "" && String(ac4Body).trim() !== "null";
    if (hasAc4) {
      if (planType !== "trial") {
        return res.status(400).json({ error: "ac4 is only supported for trial plan" });
      }
      const ac4Parsed = parseValidateAc4ForInit(ac4Body, { now });
      if (!ac4Parsed.ok) {
        return res.status(400).json({ error: ac4Parsed.error });
      }
      ac4Value = ac4Parsed.value;
      ac4JstDayStart = ac4Parsed.jstDayStart;
    }

    const sentAmount = parsePositiveAmount(body);
    // Business rule: first credit-card checkout always registers auto-renew.
    // User can cancel later via settings/admin.
    const autoRenew = true;
    const baseAmount = getPlanAmount(planType, accountType);

    if (baseAmount == null) {
      return res.status(500).json({ error: "Payment price config is invalid" });
    }
    const upgradePricing = await buildUpgradePricingContext({
      userId,
      planType,
      accountType,
      targetAmount: baseAmount,
    });
    if (upgradePricing?.blockedUpgradeNearRenewal) {
      return res.status(409).json({
        error: "Upgrade is blocked near recurring billing time. Please retry after billing window.",
        code: "UPGRADE_BLOCKED_NEAR_RENEWAL",
        nextBillingAt: upgradePricing.nextBillingAt,
        graceWindowMinutes: Math.round((upgradePricing.graceWindowMs || 0) / 60000),
        sourceOrderId: upgradePricing.sourceOrderId,
      });
    }
    const expectedAmount = upgradePricing?.expectedAmount ?? baseAmount;
    const minOnline = getMinOnlineChargeJpy();
    if (minOnline > 0 && expectedAmount > 0 && expectedAmount < minOnline) {
      return res.status(400).json({
        error:
          "Prorated charge is below the payment gateway online minimum; contact support or set PAYMENT_MIN_ONLINE_CHARGE_JPY / proration policy.",
        code: "AMOUNT_BELOW_ONLINE_MIN",
        expectedAmount,
        minOnlineChargeJpy: minOnline,
        pricing: upgradePricing || {
          mode: "regular",
          targetAmount: baseAmount,
        },
      });
    }
    if (sentAmount != null && sentAmount !== expectedAmount) {
      return res.status(400).json({
        error: "amount mismatch with server pricing",
        expectedAmount,
        pricingMode: upgradePricing?.mode || "regular",
      });
    }

    const paymentMethod = PAYMENT_METHOD.CREDIT_CARD;

    await cleanupTransientOrdersForUser(userId);
    // If user starts a new payment flow, previous "pending" orders are treated as canceled.
    await PaymentOrder.update(
      { status: "cancelled" },
      { where: { userId, status: "pending" } }
    );

    const periodStartAt = now;
    let periodEndAt =
      planType === "monthly"
        ? addMonthsInJst(now, 1)
        : planType === "yearly"
          ? addYearsInJst(now, 1)
          : addDaysInJst(now, 7);
    if (ac4JstDayStart) {
      periodEndAt = ac4JstDayStart;
    }
    const cod = buildOrderCod({ userId, accountType, planType });
    const subscriptionId = buildSubscriptionId(userId);
    const uidToken = makeOpaqueToken(12);
    const resultToken = makeOpaqueToken(12);
    const resultTokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10m

    const autoPaidAt = expectedAmount === 0 ? new Date() : null;
    const order = await PaymentOrder.create({
      cod,
      userId,
      paymentMethod,
      planType,
      accountType,
      iid: null,
      ac4: ac4Value,
      expectedAmount,
      autoRenew,
      subscriptionId,
      uidToken,
      resultToken,
      resultTokenExpiresAt,
      periodStartAt,
      periodEndAt,
      status: expectedAmount === 0 ? "paid" : "pending",
      paidAt: autoPaidAt,
      am: expectedAmount === 0 ? 0 : null,
    });
    if (ac4Value && (order.ac4 == null || String(order.ac4).trim() === "")) {
      try {
        await order.update({ ac4: ac4Value });
        await order.reload();
      } catch (e) {
        console.error("[PAYMENT INIT] ac4 follow-up update failed:", e.message);
      }
      if (order.ac4 == null || String(order.ac4).trim() === "") {
        console.error(
          "[PAYMENT INIT] ac4 still missing after create+update — check payment_orders.ac4 column and Sequelize model."
        );
      }
    }
    if (order.status === "paid") {
      await deactivateOtherPaidSubscriptions(order.userId, order.id);
      await refreshAndSyncUserSubscriptionState(order.userId);
    }

    const baseUrl = getBackendPublicBaseUrl(req);
    return res.status(201).json({
      success: true,
      order: {
        aid: String(process.env.JPAYMENT_AID || "").trim() || null,
        paymentMethod: order.paymentMethod,
        planType: order.planType,
        accountType: order.accountType,
        amount: order.expectedAmount,
        autoRenew: order.autoRenew,
        periodStartAt: order.periodStartAt,
        periodEndAt: order.periodEndAt,
        ac4: order.ac4 != null && String(order.ac4).trim() !== "" ? order.ac4 : ac4Value ?? null,
        status: order.status,
        pricing: upgradePricing
          ? {
            mode: upgradePricing.mode,
            sourcePlanType: upgradePricing.sourcePlanType,
            sourceAccountType: upgradePricing.sourceAccountType,
            sourcePlanAmount: upgradePricing.sourcePlanAmount,
            targetPlanType: upgradePricing.targetPlanType,
            targetAccountType: upgradePricing.targetAccountType,
            targetAmount: upgradePricing.targetAmount,
            isDowngrade: upgradePricing.isDowngrade,
            unusedValue: upgradePricing.unusedValue,
            appliedCredit: upgradePricing.appliedCredit,
            nonRefundedCredit: upgradePricing.nonRefundedCredit,
            remainingDays: upgradePricing.remainingDays,
            totalDays: upgradePricing.totalDays,
            chargeAmount: order.expectedAmount,
          }
          : {
            mode: "regular",
            chargeAmount: order.expectedAmount,
          },
      },
      checkoutUrl: order.expectedAmount > 0 ? `${baseUrl}/api/payment/checkout/${order.uidToken}` : null,
      resultUrl: `${baseUrl}/api/payment/result/${order.resultToken}`,
      paymentRequired: order.expectedAmount > 0,
    });
  } catch (err) {
    console.error("❌ initPaymentOrder error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/** Payment history for the logged-in user (paid + expired cycles, paginated). */
export async function listMyPaymentOrders(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    await cleanupTransientOrdersForUser(userId);
    const isAdmin = req.user?.role === "admin";
    const includeTransient = isAdmin && String(req.query.includeTransient || "").trim() === "1";
    const where = includeTransient
      ? { userId }
      : { userId, status: { [Op.in]: ["paid", "expired"] } };

    const { rows, count } = await PaymentOrder.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit,
      offset,
      attributes: { exclude: ["rawParams"] },
    });

    return res.json({
      total: count,
      limit,
      offset,
      orders: rows.map((o) => toPaymentProfilePayload(o)),
    });
  } catch (err) {
    console.error("❌ listMyPaymentOrders error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function getPaymentOrder(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const cod = String(req.params.cod || "").trim();
    if (!cod) {
      return res.status(400).json({ error: "Missing cod" });
    }

    const order = await PaymentOrder.findOne({ where: { cod, userId } });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    return res.json(order);
  } catch (err) {
    console.error("❌ getPaymentOrder error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/** BE-hosted payment entry: browser opens this URL and BE renders an auto-submit form to J-Payment. */
export async function checkoutByUid(req, res) {
  try {
    const uid = String(req.params.uid || "").trim();
    if (!uid) return res.status(400).send("invalid uid");

    const order = await PaymentOrder.findOne({ where: { uidToken: uid } });
    if (!order) return res.status(404).send("order not found");
    if (order.status !== "pending") return res.status(409).send("order already processed");
    if (order.paymentMethod && order.paymentMethod !== PAYMENT_METHOD.CREDIT_CARD) {
      return res.status(409).send("order is not credit card checkout");
    }

    const aid = (process.env.JPAYMENT_AID || "").trim();
    if (!aid) return res.status(500).send("JPAYMENT_AID is not set");
    const recurringCycle = recurringCycleCodeFromPlan(order.planType);
    const autoRenewEnabled = order.autoRenew !== false;
    const recurringAmount =
      getPlanAmount(order.planType, order.accountType) ?? (order.expectedAmount || 0);
    const displayProductName =
      order.accountType === "company"
        ? order.planType === "yearly"
          ? "法人プラン・年額払い"
          : order.planType === "trial"
            ? "法人プラン・トライアル(1週間)"
            : "法人プラン・月額払い"
        : order.planType === "yearly"
          ? "個人プラン・年額払い"
          : order.planType === "trial"
            ? "個人プラン・トライアル(1週間)"
            : "個人プラン・月額払い";
    const productRef = `PLAN_${order.accountType}_${order.planType}`;
    const ac4LinkVal =
      (order.ac4 ? formatAc4ForJpaymentLink(order.ac4) : null) ??
      (order.planType === "trial" ? formatAc4SlashFromTrialAc4StylePeriodEnd(order.periodEndAt) : null);
    console.log("[JPAY CHECKOUT] submit", {
      aid,
      endpoint: JPAY_LINK_URL,
      cod: order.cod,
      mode: "NO_PRODUCT_REGISTRATION",
      expectedAmount: order.expectedAmount,
      recurringAmount,
      ac4: ac4LinkVal || null,
    });

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Redirecting...</title></head>
<body>
  <form id="jpayCheckoutForm" action="${JPAY_LINK_URL}" method="POST" style="display:none;">
    <input type="hidden" name="aid" value="${escapeHtml(aid)}" />
    <input type="hidden" name="am" value="${escapeHtml(order.expectedAmount || 0)}" />
    <input type="hidden" name="uid" value="${escapeHtml(order.uidToken || "")}" />
    <input type="hidden" name="cod" value="${escapeHtml(order.cod)}" />
    <input type="hidden" name="tx" value="0" />
    <input type="hidden" name="sf" value="0" />
    <input type="hidden" name="jb" value="CAPTURE" />
    ${autoRenewEnabled ? `<input type="hidden" name="actp" value="${escapeHtml(recurringCycle)}" />` : ""}
    ${autoRenewEnabled ? `<input type="hidden" name="acam" value="${escapeHtml(recurringAmount)}" />` : ""}
    ${autoRenewEnabled ? `<input type="hidden" name="actx" value="0" />` : ""}
    ${autoRenewEnabled ? `<input type="hidden" name="acsf" value="0" />` : ""}
    ${ac4LinkVal ? `<input type="hidden" name="ac4" value="${escapeHtml(ac4LinkVal)}" />` : ""}
    <input type="hidden" name="inm" value="${escapeHtml(displayProductName)}" />
    <input type="hidden" name="iid2" value="${escapeHtml(productRef)}" />
  </form>
  <script>document.getElementById("jpayCheckoutForm").submit();</script>
</body></html>`;

    res.status(200).set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    console.error("❌ checkoutByUid error:", err);
    res.status(500).send("server error");
  }
}

/** FE calls this endpoint with opaque token r; cod/gateway params are not required. */
export async function getPaymentResultByToken(req, res) {
  try {
    const token = String(req.params.r || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token" });

    const order = await PaymentOrder.findOne({ where: { resultToken: token } });
    if (!order) return res.status(404).json({ error: "Result not found" });
    if (order.resultTokenExpiresAt && new Date(order.resultTokenExpiresAt) < new Date()) {
      return res.status(410).json({ error: "Result token expired" });
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    return res.json({
      status: order.status,
      paymentMethod: order.paymentMethod,
      planType: order.planType,
      accountType: order.accountType,
      amount: order.expectedAmount,
      autoRenew: order.autoRenew == null ? true : Boolean(order.autoRenew),
      // Always return persisted subscription period to avoid timezone recalculation drift.
      periodStartAt: toTimestampWithTimeZone(order.periodStartAt),
      periodEndAt: toTimestampWithTimeZone(order.periodEndAt),
      paidAt: order.paidAt,
      ac4: order.ac4 ?? null,
      gid: order.gid,
      rst: order.rst,
      ec: order.ec,
    });
  } catch (err) {
    console.error("❌ getPaymentResultByToken error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * Robot Payment / J-Payment link callback (normal payment flow)
 * Spec: callback URL format is ...?gid=...&rst=1&...&cod=...
 *
 * success: rst === "1"
 * fail:    rst === "2"
 */
export async function paymentCallback(req, res) {
  try {
    // Log full payload to inspect what J-Payment sends back.
    logPaymentCallbackSnapshot(req);

    try {
      verifyJPaymentCallbackQuerySecret(req);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).send("forbidden");
      throw e;
    }

    const q = req.query || {};
    const gid = q.gid != null ? String(q.gid).trim() : "";
    const rst = q.rst != null ? String(q.rst).trim() : "";
    const cod = normalizeCallbackCod(q.cod);

    if (!gid || !rst) {
      return res.status(400).send("missing gid/rst");
    }

    const lookupCod = cod || (q.uid != null ? String(q.uid).trim() : "");
    const callbackPayload = await sequelize.transaction(async (transaction) => {
      const byCod = lookupCod
        ? await PaymentOrder.findOne({
          where: { cod: lookupCod },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
        : null;
      // const order =
      //   byCod ||
      //   (q.uid
      //     ? await PaymentOrder.findOne({
      //       where: { uidToken: String(q.uid).trim() },
      //       transaction,
      //       lock: transaction.LOCK.UPDATE,
      //     })
      //     : null);
      // if (!order) return null;
      let order =
      byCod ||
      (q.uid
        ? await PaymentOrder.findOne({
            where: { uidToken: String(q.uid).trim() },
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : null);
    
    // fallback cho auto-renew callback (giữ pending cho callback lần đầu khi thiếu cod/uid)
    if (!order && q.acid != null) {
      order = await PaymentOrder.findOne({
        where: {
          recurringToken: String(q.acid).trim(),
          autoRenew: true,
          status: { [Op.in]: ["pending", "paid", "expired"] },
        },
        order: [["periodEndAt", "DESC"], ["createdAt", "DESC"], ["id", "DESC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    }
    
    if (!order) return null;
    
      console.log("[PAYMENT CALLBACK] updating existing order", {
        cod: order.cod,
        beforeStatus: order.status,
        incomingStatus: rst === "1" ? "paid" : "failed",
        gid,
        rst,
      });
      let workOrder = order;
      let legacyForStop = null;
      const isInitialPaymentResult = order.status === "pending";
      const incomingAcid = q.acid != null ? String(q.acid).trim() : "";
      const incomingGid = q.gid != null ? String(q.gid).trim() : "";
      const currentGid = String(order.gid || "").trim();
      const isSamePaidCallbackRetry =
        order.status === "paid" &&
        Boolean(incomingAcid) &&
        Boolean(incomingGid) &&
        Boolean(currentGid) &&
        incomingGid === currentGid;
      let paymentCallbackPath = "idempotent";
      if (isInitialPaymentResult) {
        paymentCallbackPath = "initial";
        await applyGatewayResultToOrder(order, q, { transaction });
        if (order.status === "paid") {
          const d = await deactivateOtherPaidSubscriptions(order.userId, order.id, transaction);
          legacyForStop = d.legacy;
        }
        workOrder = order;
      } else if (isSamePaidCallbackRetry) {
        paymentCallbackPath = "idempotent";
        workOrder = order;
      } else if (q.acid != null) {
        paymentCallbackPath = "renewal";
        workOrder = (await handleAutoRenewResultCallback(order, q, transaction)) || order;
      } else {
        await applyGatewayResultToOrder(order, q, { transaction });
        workOrder = order;
      }
      if (!legacyForStop && rst === "1" && workOrder.status === "paid") {
        legacyForStop = await findLegacyStopCandidate(order.userId, order.id, incomingAcid, transaction);
      }
      const resultToken = await ensureResultToken(workOrder, { transaction });
      // getUserSubscriptionState → User.update: must run AFTER commit, not inside this transaction (avoids
      // "Resolve lock timeout" and lets us return 200 + stop-bridge HTML even if Users row is contended).
      // Path "idempotent" = trùng callback trên đã-paid (beforeStatus paid) → không cần User.update, tránh lock vô ích.
      const subscriptionSyncNeeded = paymentCallbackPath !== "idempotent";
      console.log("[PAYMENT CALLBACK] updated", {
        cod: workOrder.cod,
        afterStatus: workOrder.status,
        gid: workOrder.gid,
        rst: workOrder.rst,
        paymentCallbackPath,
        subscriptionSyncNeeded,
      });
      return { order: workOrder, legacyForStop, resultToken, userId: workOrder.userId, subscriptionSyncNeeded };
    });

    if (!callbackPayload) {
      console.warn("[PAYMENT CALLBACK] no matching order — ignored (no orphan row)", {
        gid,
        rst,
        lookupCod: lookupCod || null,
      });
    } else {
      if (callbackPayload.subscriptionSyncNeeded && callbackPayload.userId) {
        try {
          await refreshAndSyncUserSubscriptionState(callbackPayload.userId);
        } catch (syncErr) {
          console.error("❌ [PAYMENT CALLBACK] post-commit subscription sync failed (non-fatal; vẫn trả OK/bridge)", syncErr);
        }
      }
    }

    const aid = String(process.env.JPAYMENT_AID || "").trim();
    const { legacyForStop } = callbackPayload || {};
    if (callbackPayload && rst === "1") {
      await stopLegacyAutoCharge({
        aid,
        legacyForStop,
        source: "payment/callback",
        expectedUserId: callbackPayload.userId,
      });
    }

    // Spec: callback is treated as successful when HTML is returned on the first line.
    res.status(200).send("<html><body>OK</body></html>");
  } catch (err) {
    console.error("❌ paymentCallback error:", err);
    res.status(500).send("<html><body>NG</body></html>");
  }
}

/** Browser return URL from J-Payment: update order then redirect FE with opaque result token */
export async function paymentReturn(req, res) {
  try {
    logPaymentCallbackSnapshot(req);
    const q = req.query || {};
    const cod = q.cod != null ? String(q.cod).trim() : "";
    const uid = q.uid != null ? String(q.uid).trim() : "";
    const hasGatewayResult = q.gid != null && q.rst != null;

    const returnPayload = await sequelize.transaction(async (transaction) => {
      let order = null;
      if (cod) {
        order = await PaymentOrder.findOne({
          where: { cod },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
      }
      if (!order && uid) {
        order = await PaymentOrder.findOne({
          where: { uidToken: uid },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
      }
      if (!order) return null;

      const statusBefore = order.status;
      let legacyForStop = null;
      if (hasGatewayResult) {
        await applyGatewayResultToOrder(order, q, { transaction });
        if (order.status === "paid") {
          const d = await deactivateOtherPaidSubscriptions(order.userId, order.id, transaction);
          legacyForStop = d.legacy;
        }
        if (!legacyForStop && String(q.rst || "").trim() === "1" && order.status === "paid") {
          legacyForStop = await findLegacyStopCandidate(order.userId, order.id, q.acid, transaction);
        }
      } else {
        console.warn("[PAYMENT RETURN] missing gid/rst; keep current order status", {
          cod: order.cod,
          uid: order.uidToken,
        });
      }
      const resultToken = await ensureResultToken(order, { transaction });
      // Sync User.subscriptionPlan sau commit: tránh lock timeout trong transaction; skip nếu đã paid từ trước (idempotent)
      const subscriptionSyncNeeded = hasGatewayResult && statusBefore === "pending";
      return {
        resultToken,
        legacyForStop,
        orderPaidWithGateway: hasGatewayResult && order.status === "paid",
        userId: order.userId,
        subscriptionSyncNeeded,
      };
    });
    if (!returnPayload?.resultToken) {
      return res.status(404).send("order not found");
    }

    if (returnPayload.subscriptionSyncNeeded && returnPayload.userId) {
      try {
        await refreshAndSyncUserSubscriptionState(returnPayload.userId);
      } catch (syncErr) {
        console.error("❌ [PAYMENT RETURN] post-commit subscription sync failed (non-fatal)", syncErr);
      }
    }

    const { resultToken, legacyForStop, orderPaidWithGateway } = returnPayload;
    const aid = String(process.env.JPAYMENT_AID || "").trim();
    if (orderPaidWithGateway && String(q.rst || "").trim() === "1") {
      await stopLegacyAutoCharge({
        aid,
        legacyForStop,
        source: "payment/return",
        expectedUserId: returnPayload.userId,
      });
    }

    const feReturn = getFrontendReturnUrl();
    if (!feReturn) {
      return res.status(200).json({
        message: "PAYMENT_FRONTEND_RETURN_URL not set",
        r: resultToken,
      });
    }
    const to = `${feReturn}${feReturn.includes("?") ? "&" : "?"}r=${encodeURIComponent(resultToken)}`;
    return res.redirect(302, to);
  } catch (err) {
    console.error("❌ paymentReturn error:", err);
    return res.status(500).send("server error");
  }
}

