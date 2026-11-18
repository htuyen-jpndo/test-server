import { PaymentOrder } from "../models/paymentOrder.model.js";
import { Op } from "sequelize";
import { PAYMENT_METHOD } from "./paymentEnums.js";
import { toTimestampWithTimeZone } from "./time.js";

export const PAYMENT_PLAN_JA = { monthly: "月額", yearly: "年額", trial: "トライアル(1週間)" };
export const PAYMENT_METHOD_JA = {
  [PAYMENT_METHOD.CREDIT_CARD]: "クレジットカード",
  [PAYMENT_METHOD.BANK_TRANSFER]: "銀行振込",
  [PAYMENT_METHOD.FREE]: "決済免除",
};
export const PAYMENT_ACCOUNT_JA = { personal: "個人", company: "法人" };
export const PAYMENT_STATUS_JA = {
  pending: "未払い",
  paid: "支払い済み",
  failed: "失敗",
  cancelled: "キャンセル",
  expired: "期限切れ",
};

function formatDateTimeJa(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildPaymentDisplayJa(row) {
  const yen = (n) =>
    n == null || Number.isNaN(Number(n)) ? null : `${Number(n).toLocaleString("ja-JP")}円`;
  return {
    paymentMethod: PAYMENT_METHOD_JA[row.paymentMethod] ?? row.paymentMethod ?? null,
    planType: PAYMENT_PLAN_JA[row.planType] ?? row.planType ?? null,
    accountType: PAYMENT_ACCOUNT_JA[row.accountType] ?? row.accountType ?? null,
    status: PAYMENT_STATUS_JA[row.status] ?? row.status ?? null,
    expectedAmount: yen(row.expectedAmount),
    paidAmount: yen(row.am),
    periodStartAt: formatDateTimeJa(row.periodStartAt),
    periodEndAt: formatDateTimeJa(row.periodEndAt),
    paidAt: formatDateTimeJa(row.paidAt),
    createdAt: formatDateTimeJa(row.createdAt),
  };
}

/** Payload thống nhất cho profile / history (không lộ rawParams). */
export function toPaymentProfilePayload(order) {
  if (!order) return null;
  return {
    id: order.id,
    cod: order.cod,
    status: order.status,
    paymentMethod: order.paymentMethod ?? null,
    planType: order.planType,
    accountType: order.accountType,
    expectedAmount: order.expectedAmount,
    autoRenew: order.autoRenew == null ? true : Boolean(order.autoRenew),
    paidAmount: order.am,
    periodStartAt: toTimestampWithTimeZone(order.periodStartAt),
    periodEndAt: toTimestampWithTimeZone(order.periodEndAt),
    paidAt: toTimestampWithTimeZone(order.paidAt),
    createdAt: toTimestampWithTimeZone(order.createdAt),
    ac4: order.ac4 ?? null,
    displayJa: buildPaymentDisplayJa(order),
  };
}

export function getLatestPaidForUser(userId) {
  return PaymentOrder.findOne({
    where: { userId, status: "paid" },
    order: [["createdAt", "DESC"]],
  });
}

export function getLatestPendingForUser(userId) {
  const recentFrom = new Date(Date.now() - 10 * 60 * 1000);
  return PaymentOrder.findOne({
    where: {
      userId,
      status: "pending",
      createdAt: { [Op.gte]: recentFrom },
    },
    order: [["createdAt", "DESC"]],
  });
}
