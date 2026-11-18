import { Op } from "sequelize";
import { PaymentOrder } from "../models/paymentOrder.model.js";
import { stopJPaymentAutoCharge } from "./jpaymentGateway.js";

/** Failure codes the stop-retry worker will pick up. */
export const AUTO_CHARGE_STOP_RETRY_CODES = ["STOP_API_FAILED", "GATEWAY_REFUNDED_STOP_FAILED"];

const STOP_RETRY_DELAYS_MS = [1000, 3000, 5000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calendar date in Asia/Tokyo as YYYY-MM-DD (renewNextRetryAt is DATEONLY). */
export function jstDateOnlyString(date = new Date()) {
  const jstMs = date.getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

/** Next JST calendar date. Japan has no DST, so +24h always crosses one JST midnight. */
export function nextJstDateOnlyString(from = new Date()) {
  return jstDateOnlyString(new Date(from.getTime() + 24 * 60 * 60 * 1000));
}

function preserveFailureCode(existing) {
  if (existing && AUTO_CHARGE_STOP_RETRY_CODES.includes(existing)) return existing;
  return "STOP_API_FAILED";
}

async function markStopRetry(legacyOrder) {
  await legacyOrder.update({
    renewFailureCode: preserveFailureCode(legacyOrder.renewFailureCode),
    renewNextRetryAt: nextJstDateOnlyString(),
    renewLastAttemptAt: new Date(),
  });
}

/**
 * Stop one legacy auto-charge (acsgate cmd=1) and persist the outcome.
 * Success sets stopRequested and autoRenew=false.
 * Failure records renewFailureCode + renewNextRetryAt for the retry worker.
 * In-request attempts use short delays; the worker covers later retries.
 */
export async function stopLegacyAutoCharge({
  aid,
  legacyForStop,
  source = "unknown",
  expectedUserId = null,
} = {}) {
  const legacyOrderId = legacyForStop?.legacyOrderId || null;
  const acid = String(legacyForStop?.acid || "").trim();
  const normalizedAid = String(aid || "").trim();

  if (!acid || !legacyOrderId) {
    return { attempted: false, ok: false, skipped: true, reason: "missing_stop_target" };
  }

  const legacyOrder = await PaymentOrder.findByPk(legacyOrderId);
  if (!legacyOrder) {
    console.warn("[STOP_RECURRING] legacy order not found", { legacyOrderId, source });
    return { attempted: false, ok: false, skipped: true, reason: "legacy_order_not_found" };
  }
  if (expectedUserId && Number(legacyOrder.userId) !== Number(expectedUserId)) {
    console.error("[STOP_RECURRING] user mismatch; abort stop", {
      source,
      action: "STOP_RECURRING",
      legacyOrderId,
      expectedUserId,
      actualUserId: legacyOrder.userId,
    });
    return { attempted: false, ok: false, skipped: true, reason: "user_mismatch" };
  }
  if (legacyOrder.stopRequested) {
    if (legacyOrder.autoRenew !== false) {
      await legacyOrder.update({ autoRenew: false });
    }
    console.log("[STOP_RECURRING] skip duplicate request", {
      source,
      legacyOrderId,
      userId: legacyOrder.userId,
      action: "STOP_RECURRING",
      reason: "already_requested",
    });
    return { attempted: false, ok: true, skipped: true, reason: "already_requested" };
  }

  if (!normalizedAid) {
    console.error("[STOP_RECURRING] JPAYMENT_AID is not set; scheduling retry", {
      source,
      legacyOrderId,
    });
    await markStopRetry(legacyOrder);
    return {
      attempted: false,
      ok: false,
      skipped: false,
      reason: "missing_aid",
      reasonDetail: "JPAYMENT_AID is not set — acsgate stop was not called.",
      retryLater: true,
    };
  }

  let lastResult = null;
  for (let i = 0; i < STOP_RETRY_DELAYS_MS.length; i += 1) {
    if (i > 0) await sleep(STOP_RETRY_DELAYS_MS[i]);
    lastResult = await stopJPaymentAutoCharge({ aid: normalizedAid, acid });
    const log = lastResult?.ok ? console.log : console.error;
    log.call(console, "[STOP_RECURRING] attempt", {
      action: "STOP_RECURRING",
      source,
      attempt: i + 1,
      legacyOrderId,
      userId: legacyOrder.userId,
      acidMasked: lastResult?.acidMasked || null,
      ok: lastResult?.ok || false,
      reason: lastResult?.reason || null,
      errorCode: lastResult?.errorCode || null,
      httpStatus: lastResult?.httpStatus ?? null,
    });
    if (lastResult?.ok) break;
  }

  if (lastResult?.ok) {
    await legacyOrder.update({
      stopRequested: true,
      stopRequestedAt: new Date(),
      autoRenew: false,
      renewFailureCode: null,
      renewNextRetryAt: null,
    });
    return lastResult;
  }

  await markStopRetry(legacyOrder);
  return { ...(lastResult || { attempted: true, ok: false }), retryLater: true };
}

/** Stop each distinct acid once. */
export async function stopLegacyAutoCharges(legacies, opts = {}) {
  const seen = new Set();
  const results = [];
  for (const legacy of legacies || []) {
    const acid = String(legacy?.acid || "").trim();
    if (!acid || seen.has(acid)) continue;
    seen.add(acid);
    const result = await stopLegacyAutoCharge({ ...opts, legacyForStop: legacy });
    results.push(result);
  }
  return results;
}

export async function getAutoChargeStopsDue(asOf = new Date()) {
  const today = jstDateOnlyString(asOf);
  return PaymentOrder.findAll({
    where: {
      stopRequested: false,
      renewFailureCode: { [Op.in]: AUTO_CHARGE_STOP_RETRY_CODES },
      recurringToken: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: "" }] },
      [Op.or]: [{ renewNextRetryAt: null }, { renewNextRetryAt: { [Op.lte]: today } }],
    },
    order: [
      ["renewNextRetryAt", "ASC"],
      ["id", "ASC"],
    ],
    limit: 25,
  });
}
