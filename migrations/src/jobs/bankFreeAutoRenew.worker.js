import { Op } from "sequelize";
import { sequelize } from "../config/db.js";
import { PaymentOrder } from "../models/paymentOrder.model.js";
import { PAYMENT_METHOD } from "../utils/paymentEnums.js";
import { getPlanAmount } from "../utils/paymentPricing.js";
import { buildNextPeriodFromPeriodEnd } from "../utils/subscriptionRenewalPeriod.js";
import { refreshAndSyncUserSubscriptionState } from "../middlewares/subscription.middleware.js";

function buildManualRenewCod(sourceOrder) {
  return `ORD_${sourceOrder.userId}_${sourceOrder.accountType}_${sourceOrder.planType}_BANKFREE_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Paid BANK_TRANSFER / FREE orders past periodEndAt with autoRenew on.
 * Excludes trial (no automatic segment extension).
 */
export async function getBankFreeAutoRenewableDue(asOf = new Date()) {
  return PaymentOrder.findAll({
    where: {
      status: "paid",
      autoRenew: true,
      paymentMethod: { [Op.in]: [PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.FREE] },
      cancelledAt: null,
      periodEndAt: { [Op.lte]: asOf },
      planType: { [Op.in]: ["monthly", "yearly"] },
    },
    order: [["periodEndAt", "ASC"]],
  });
}

/**
 * One renewal: new paid row + expire source (mirrors card renewal shape, no gateway).
 */
export async function renewBankFreeOrderOnce(sourceOrder) {
  const sid = String(sourceOrder.subscriptionId || "").trim();
  if (!sid) {
    console.warn("[BANK_FREE_RENEW] skip: missing subscriptionId", { orderId: sourceOrder.id });
    return { ok: false, reason: "missing_subscription_id" };
  }

  return sequelize.transaction(async (transaction) => {
    const locked = await PaymentOrder.findByPk(sourceOrder.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!locked || locked.status !== "paid" || !locked.autoRenew) {
      return { ok: false, reason: "order_not_eligible" };
    }
    if (
      locked.paymentMethod !== PAYMENT_METHOD.BANK_TRANSFER &&
      locked.paymentMethod !== PAYMENT_METHOD.FREE
    ) {
      return { ok: false, reason: "wrong_payment_method" };
    }

    const newerPaid = await PaymentOrder.findOne({
      where: {
        userId: locked.userId,
        status: "paid",
        id: { [Op.ne]: locked.id },
        periodEndAt: { [Op.gt]: locked.periodEndAt },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (newerPaid) {
      await locked.update(
        { status: "expired", renewLastAttemptAt: new Date() },
        { transaction }
      );
      return { ok: true, reason: "superseded_by_newer_order" };
    }

    const existingRenewal = await PaymentOrder.findOne({
      where: {
        subscriptionId: sid,
        renewalForPeriodEndAt: locked.periodEndAt,
        status: "paid",
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existingRenewal) {
      if (Number(existingRenewal.sourceOrderId) === Number(locked.id)) {
        return { ok: true, reason: "already_renewed", orderId: existingRenewal.id };
      }
      await locked.update(
        { status: "expired", renewLastAttemptAt: new Date() },
        { transaction }
      );
      return { ok: true, reason: "stale_expired", orderId: existingRenewal.id };
    }

    const period = buildNextPeriodFromPeriodEnd(locked.planType, locked.periodEndAt);
    if (!period) {
      return { ok: false, reason: "invalid_period" };
    }

    const expectedAmount =
      getPlanAmount(locked.planType, locked.accountType) ?? locked.expectedAmount ?? 0;
    const paidAmount = locked.am ?? locked.expectedAmount ?? expectedAmount;

    const renewal = await PaymentOrder.create(
      {
        cod: buildManualRenewCod(locked),
        userId: locked.userId,
        paymentMethod: locked.paymentMethod,
        planType: locked.planType,
        accountType: locked.accountType,
        iid: locked.iid || null,
        expectedAmount,
        autoRenew: locked.autoRenew,
        subscriptionId: sid,
        recurringToken: null,
        sourceOrderId: locked.id,
        renewalForPeriodEndAt: locked.periodEndAt,
        periodStartAt: period.start,
        periodEndAt: period.end,
        status: "paid",
        paidAt: new Date(),
        am: paidAmount,
        renewFailureCode: null,
        renewRetryCount: 0,
        renewNextRetryAt: null,
        renewLastAttemptAt: new Date(),
        rawParams: JSON.stringify({ source: "BANK_FREE_AUTO_RENEW", sourceOrderId: locked.id }),
      },
      { transaction }
    );

    await locked.update(
      {
        status: "expired",
        renewFailureCode: null,
        renewNextRetryAt: null,
        renewLastAttemptAt: new Date(),
      },
      { transaction }
    );

    return { ok: true, reason: "renewed", orderId: renewal.id };
  });
}

export async function runBankFreeAutoRenewBatch() {
  const due = await getBankFreeAutoRenewableDue(new Date());
  let renewed = 0;
  let skipped = 0;
  for (const row of due) {
    try {
      const r = await renewBankFreeOrderOnce(row);
      if (r.ok && r.reason === "renewed") renewed += 1;
      else if (!r.ok) skipped += 1;
      if (r.ok) {
        await refreshAndSyncUserSubscriptionState(row.userId);
      }
    } catch (e) {
      console.error("[BANK_FREE_RENEW] batch item failed", { orderId: row.id, message: e.message });
      skipped += 1;
    }
  }
  if (due.length) {
    console.log("[BANK_FREE_RENEW] batch done", { candidates: due.length, renewed, skipped });
  }
  return { candidates: due.length, renewed, skipped };
}

let intervalId = null;

export function startBankFreeAutoRenewWorker() {
  const enabled = String(process.env.PAYMENT_BANK_FREE_AUTO_RENEW_WORKER_ENABLED || "").trim() === "true";
  if (!enabled) return;
  const ms = Number(process.env.PAYMENT_AUTO_RENEW_INTERVAL_MS) || 300000;
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => {
    runBankFreeAutoRenewBatch().catch((e) => console.error("[BANK_FREE_RENEW] interval error", e));
  }, ms);
  console.log(`✅ BANK/FREE auto-renew worker enabled (every ${ms}ms)`);
  runBankFreeAutoRenewBatch().catch((e) => console.error("[BANK_FREE_RENEW] initial run error", e));
}
