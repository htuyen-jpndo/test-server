import { PaymentOrder } from "../models/paymentOrder.model.js";
import { Op } from "sequelize";
import { User } from "../models/user.model.js";
import { PAYMENT_METHOD } from "../utils/paymentEnums.js";
import { toTimestampWithTimeZone } from "../utils/time.js";
import { parseJstDateTime } from "../utils/jstDate.js";

const SUBSCRIPTION_CACHE_TTL_MS = 15 * 1000;
const subscriptionCache = new Map();

/** periodEndAt: date-only YYYY-MM-DD = end of that JST day; datetime = that JST wall clock. */
function parsePeriodEndAtForExpiry(raw) {
  return parseJstDateTime(raw, { endOfDayForDateOnly: true });
}

function isOrderExpired(order) {
  if (!order) return true;
  const periodEnd = parsePeriodEndAtForExpiry(order.periodEndAt);
  if (!periodEnd) return true;
  const now = new Date();
  return periodEnd <= now;
}

/** Giữ đơn `paid` trong DB để worker auto-renew vẫn thấy đơn; user/API vẫn nhận snapshot expired. */
function shouldKeepPaidOrderForAutoRenewWorker(order) {
  if (!order) return false;
  if (order.autoRenew === false) return false;
  if (order.paymentMethod === PAYMENT_METHOD.CREDIT_CARD) return true;
  if (
    order.paymentMethod === PAYMENT_METHOD.BANK_TRANSFER ||
    order.paymentMethod === PAYMENT_METHOD.FREE
  ) {
    return true;
  }
  return false;
}

function toSnapshot(order, statusOverride = null) {
  const status = statusOverride || (order ? (isOrderExpired(order) ? "expired" : "active") : "inactive");
  const code =
    status === "active"
      ? "SUB_ACTIVE"
      : status === "expired"
        ? "SUB_EXPIRED"
        : "SUB_NOT_FOUND";
  return {
    status,
    code,
    paymentMethod: order?.paymentMethod ?? null,
    planType: order?.planType || null,
    accountType: order?.accountType || null,
    autoRenew: order?.autoRenew == null ? true : Boolean(order.autoRenew),
    periodEndAt: toTimestampWithTimeZone(order?.periodEndAt || null),
    paymentOrderId: order?.id || null,
    hasPaidOrder: Boolean(order),
  };
}

function getCachedSubscription(userId) {
  const hit = subscriptionCache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    subscriptionCache.delete(userId);
    return null;
  }
  return hit.data;
}

function setCachedSubscription(userId, data) {
  subscriptionCache.set(userId, {
    data,
    expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS,
  });
}

function resolveSubscriptionPlanFromSnapshot(snapshot) {
  if (!snapshot || snapshot.status !== "active") return "none";
  const accountType = snapshot.accountType;
  const planType = snapshot.planType;
  if (
    (accountType === "personal" || accountType === "company") &&
    (planType === "monthly" || planType === "yearly" || planType === "trial")
  ) {
    return `${accountType}_${planType}`;
  }
  return "none";
}

async function syncUserSubscriptionPlan(userId, snapshot) {
  if (!userId) return;
  const subscriptionPlan = resolveSubscriptionPlanFromSnapshot(snapshot);
  await User.update({ subscriptionPlan }, { where: { id: userId } });
}

export function invalidateUserSubscriptionCache(userId) {
  if (!userId) return;
  subscriptionCache.delete(userId);
}

export async function getUserSubscriptionState(userId, options = {}) {
  const { forceRefresh = false } = options;
  if (!forceRefresh) {
    const cached = getCachedSubscription(userId);
    if (cached) return cached;
  }

  const latestPaid = await PaymentOrder.findOne({
    where: { userId, status: "paid" },
    order: [["createdAt", "DESC"]],
  });

  if (!latestPaid) {
    const inactive = toSnapshot(null, "inactive");
    await syncUserSubscriptionPlan(userId, inactive);
    setCachedSubscription(userId, inactive);
    return inactive;
  }

  if (isOrderExpired(latestPaid)) {
    if (shouldKeepPaidOrderForAutoRenewWorker(latestPaid)) {
      const expired = toSnapshot(latestPaid, "expired");
      await syncUserSubscriptionPlan(userId, expired);
      setCachedSubscription(userId, expired);
      return expired;
    }
    // Enforce cứng: đã hết hạn thì chuyển trạng thái đơn về expired.
    await latestPaid.update({ status: "expired" });
    await PaymentOrder.update(
      { status: "expired" },
      {
        where: {
          userId,
          status: "paid",
          id: { [Op.ne]: latestPaid.id },
          periodEndAt: { [Op.lte]: new Date() },
        },
      }
    );
    const expired = toSnapshot(latestPaid, "expired");
    await syncUserSubscriptionPlan(userId, expired);
    setCachedSubscription(userId, expired);
    return expired;
  }

  const active = toSnapshot(latestPaid, "active");
  await syncUserSubscriptionPlan(userId, active);
  setCachedSubscription(userId, active);
  return active;
}

export async function refreshAndSyncUserSubscriptionState(userId) {
  invalidateUserSubscriptionCache(userId);
  return getUserSubscriptionState(userId, { forceRefresh: true });
}

// Dùng cho cron/worker: chỉ renew subscription đang active và autoRenew bật.
export async function getAutoRenewableSubscriptionsDue(dateOnly) {
  const targetDate = dateOnly || new Date();
  return PaymentOrder.findAll({
    where: {
      status: "paid",
      autoRenew: true,
      paymentMethod: PAYMENT_METHOD.CREDIT_CARD,
      periodEndAt: { [Op.lte]: targetDate },
      [Op.or]: [
        { renewNextRetryAt: null },
        { renewNextRetryAt: { [Op.lte]: targetDate } },
      ],
    },
    order: [["periodEndAt", "ASC"]],
  });
}

export async function requireActiveSubscription(req, res, next) {
  try {
    const user = req.user || {};
    const userId = user.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Admin luôn được truy cập để quản trị hệ thống.
    if (user.role === "admin") {
      return next();
    }

    const subscription = await getUserSubscriptionState(userId);
    if (subscription.status !== "active") {
      return res.status(403).json({
        error: "Active subscription required",
        code: "SUBSCRIPTION_REQUIRED",
        reasonCode: subscription.code,
        redirectTo: "/pricing",
        subscription,
      });
    }

    req.subscription = subscription;
    return next();
  } catch (err) {
    console.error("❌ requireActiveSubscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
