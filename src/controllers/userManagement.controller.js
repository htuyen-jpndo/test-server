import { User } from "../models/user.model.js";
import { Flight, Pilot, Maintenance } from "../models/index.js";
import { sequelize } from "../config/db.js";
import { Op } from "sequelize";
import bcrypt from "bcryptjs";
import { generateToken } from "../utils/jwt.js";
import { PaymentOrder } from "../models/paymentOrder.model.js";
import { UserPaymentCancellation } from "../models/userPaymentCancellation.model.js";
import { toPaymentProfilePayload } from "../utils/paymentProfile.js";
import { refreshAndSyncUserSubscriptionState } from "../middlewares/subscription.middleware.js";
import { PAYMENT_METHOD, parsePaymentMethod } from "../utils/paymentEnums.js";
import {
  cancelGatewayTransaction,
  maskJPaymentAcid,
} from "../utils/jpaymentGateway.js";
import { nextJstDateOnlyString, stopLegacyAutoCharge, stopLegacyAutoCharges } from "../utils/autoChargeStop.js";
import { parseJstDateTime } from "../utils/jstDate.js";
import { getPlanAmount } from "../utils/paymentPricing.js";
import {
  USER_STATUS,
  isUserSuspended,
  parseUserStatus,
  sendSuspendedAccountResponse,
} from "../utils/userStatus.js";

const PAYMENT_METHOD_OPTIONS = Object.values(PAYMENT_METHOD);

function toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseAutoRenewOrNull(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

function makeAdminManualCod(userId, accountType = "personal", planType = "monthly") {
  return `ORD_${userId}_${accountType}_${planType}_ADMIN_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function makeAdminPaymentOrderCod(userId, accountType = "personal", planType = "monthly") {
  return `ORD_${userId}_${accountType}_${planType}_ADMIN_PO_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function makeSubscriptionId(userId) {
  return `SUB_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parsePositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function parseDateInputToLocalDate(raw) {
  return parseJstDateTime(raw, { endOfDayForDateOnly: true });
}

function parseNullableDateTime(raw, { endOfDayForDateOnly = false } = {}) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? `${s}${endOfDayForDateOnly ? " 23:59:59" : " 00:00:00"}`
    : s.replace("T", " ");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return normalized;
}

function removeNullFields(value) {
  if (Array.isArray(value)) {
    return value.map(removeNullFields);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = removeNullFields(v);
    }
    return out;
  }
  return value;
}

function resolveSubscriptionPlanFromLatestPaid(order) {
  if (!order || order.status !== "paid") return "none";
  const periodEnd = parseDateInputToLocalDate(order.periodEndAt);
  if (!periodEnd) return "none";
  if (periodEnd <= new Date()) return "none";
  if (
    (order.accountType === "personal" || order.accountType === "company") &&
    (order.planType === "monthly" || order.planType === "yearly" || order.planType === "trial")
  ) {
    return `${order.accountType}_${order.planType}`;
  }
  return "none";
}

// Get all users (admin only)
export async function getAllUsers(req, res) {
  try {
    const users = await User.findAll({
      attributes: { exclude: ["password", "resetCode", "resetExpire"] },
      order: [["createdAt", "DESC"]],
    });

    // Count flights and maintenances for each user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const [flightCount, maintenanceCount, latestPaidPayment, latestPendingPayment] = await Promise.all([
          Flight.count({ where: { userId: user.id } }),
          Maintenance.count({ where: { userId: user.id } }),
          PaymentOrder.findOne({
            where: { userId: user.id, status: "paid" },
            order: [["createdAt", "DESC"]],
          }),
          PaymentOrder.findOne({
            where: { userId: user.id, status: "pending" },
            order: [["createdAt", "DESC"]],
          }),
        ]);

        return {
          ...user.toJSON(),
          subscriptionPlan: resolveSubscriptionPlanFromLatestPaid(latestPaidPayment),
          stats: {
            flights: flightCount,
            maintenances: maintenanceCount,
          },
          payments: {
            latestPaid: toPaymentProfilePayload(latestPaidPayment),
            latestPending: toPaymentProfilePayload(latestPendingPayment),
          },
        };
      })
    );

    res.json({ users: usersWithStats });
  } catch (err) {
    console.error("❌ getAllUsers error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

// Get one user with all related data
export async function getUserDetails(req, res) {
  try {
    const { userId } = req.params;

    const user = await User.findByPk(userId, {
      attributes: { exclude: ["password", "resetCode", "resetExpire"] },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get user's flights (including pilot from pilots table)
    const flights = await Flight.findAll({
      where: { userId },
      include: [{ model: Pilot, as: "Pilot", attributes: ["id", "fullName", "organization", "certificateType", "certificateNumber", "expiredDate"] }],
      order: [["takeoffTime", "DESC"]],
    });

    const maintenances = await Maintenance.findAll({
      where: { userId },
      order: [["date", "DESC"]],
    });

    const [latestPaidPayment, latestPendingPayment, paymentOrders] = await Promise.all([
      PaymentOrder.findOne({
        where: { userId, status: "paid" },
        order: [["createdAt", "DESC"]],
      }),
      PaymentOrder.findOne({
        where: { userId, status: "pending" },
        order: [["createdAt", "DESC"]],
      }),
      PaymentOrder.findAll({
        where: { userId },
        order: [["createdAt", "DESC"]],
      }),
    ]);

    res.json({
      user: {
        ...user.toJSON(),
        subscriptionPlan: resolveSubscriptionPlanFromLatestPaid(latestPaidPayment),
      },
      flights,
      maintenances,
      stats: {
        totalFlights: flights.length,
        totalMaintenances: maintenances.length,
      },
      payments: {
        latestPaid: toPaymentProfilePayload(latestPaidPayment),
        latestPending: toPaymentProfilePayload(latestPendingPayment),
        recentOrders: paymentOrders.map((o) => toPaymentProfilePayload(o)),
      },
    });
  } catch (err) {
    console.error("❌ getUserDetails error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

// Admin manually updates package/payment for a user (can switch paymentMethod to BANK_TRANSFER / FREE here)
export async function adminUpsertUserPayment(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const targetUser = await User.findByPk(userId, {
      attributes: ["id", "name", "email", "role", "status"],
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const body = req.body || {};
    const planType = body.planType;
    const accountType = body.accountType;
    const status = body.status;
    const expectedAmount = toIntOrNull(body.expectedAmount);
    const paidAmount = toIntOrNull(body.paidAmount);
    const parsedAutoRenew = parseAutoRenewOrNull(body.autoRenew);
    const periodStartAt = parseNullableDateTime(body.periodStartAt);
    const periodEndAt = parseNullableDateTime(body.periodEndAt, { endOfDayForDateOnly: true });
    const paidAt = parseNullableDateTime(body.paidAt);

    if (planType != null && !["monthly", "yearly", "trial"].includes(planType)) {
      return res.status(400).json({ error: "planType must be monthly, yearly, or trial" });
    }
    if (body.paymentMethod != null && body.paymentMethod !== "" && !parsePaymentMethod(body.paymentMethod)) {
      return res.status(400).json({ error: "paymentMethod must be CREDIT_CARD, BANK_TRANSFER, or FREE" });
    }
    if (accountType != null && !["personal", "company"].includes(accountType)) {
      return res.status(400).json({ error: "accountType must be personal or company" });
    }
    if (status != null && !["pending", "paid", "failed", "cancelled", "expired"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    if (body.expectedAmount !== undefined && expectedAmount == null) {
      return res.status(400).json({ error: "expectedAmount must be a number" });
    }
    if (body.paidAmount !== undefined && paidAmount == null) {
      return res.status(400).json({ error: "paidAmount must be a number" });
    }
    if (body.autoRenew !== undefined && parsedAutoRenew == null) {
      return res.status(400).json({ error: "autoRenew must be boolean (true/false)" });
    }
    if (body.periodStartAt !== undefined && periodStartAt == null) {
      return res.status(400).json({ error: "periodStartAt must be valid datetime" });
    }
    if (body.periodEndAt !== undefined && periodEndAt == null) {
      return res.status(400).json({ error: "periodEndAt must be valid datetime" });
    }
    if (body.paidAt !== undefined && paidAt == null) {
      return res.status(400).json({ error: "paidAt must be valid datetime" });
    }

    const paymentOrderId = toIntOrNull(body.paymentOrderId);
    let order = null;
    if (paymentOrderId != null) {
      order = await PaymentOrder.findOne({ where: { id: paymentOrderId, userId } });
      if (!order) return res.status(404).json({ error: "Payment order not found" });
    } else {
      order = await PaymentOrder.findOne({
        where: { userId },
        order: [["createdAt", "DESC"]],
      });
    }

    if (!order) {
      const cod = makeAdminManualCod(userId, accountType || "personal", planType || "monthly");
      const paymentMethod = parsePaymentMethod(body.paymentMethod) ?? PAYMENT_METHOD.CREDIT_CARD;
      const subscriptionId = makeSubscriptionId(userId);
      const autoRenewForMethod = parsedAutoRenew == null ? true : parsedAutoRenew;
      order = await PaymentOrder.create({
        cod,
        userId,
        paymentMethod,
        planType: planType || "monthly",
        accountType: accountType || "personal",
        expectedAmount: expectedAmount ?? 0,
        autoRenew: autoRenewForMethod,
        subscriptionId,
        status: status || "paid",
        am: paidAmount,
        paidAt: paidAt || null,
        periodStartAt,
        periodEndAt,
      });
    } else {
      const updates = {};
      if (body.paymentMethod !== undefined) {
        updates.paymentMethod =
          body.paymentMethod === null || body.paymentMethod === ""
            ? null
            : parsePaymentMethod(body.paymentMethod);
        if (body.paymentMethod !== null && body.paymentMethod !== "" && !updates.paymentMethod) {
          return res.status(400).json({ error: "paymentMethod must be CREDIT_CARD, BANK_TRANSFER, or FREE" });
        }
      }
      if (planType !== undefined) updates.planType = planType;
      if (accountType !== undefined) updates.accountType = accountType;
      if (status !== undefined) updates.status = status;
      if (body.expectedAmount !== undefined) updates.expectedAmount = expectedAmount;
      if (body.autoRenew !== undefined) {
        updates.autoRenew = parsedAutoRenew;
      }
      if (body.paidAmount !== undefined) updates.am = paidAmount;
      if (body.periodStartAt !== undefined) updates.periodStartAt = periodStartAt;
      if (body.periodEndAt !== undefined) updates.periodEndAt = periodEndAt;
      if (body.paidAt !== undefined) updates.paidAt = paidAt;

      const acidBefore = String(order.recurringToken || "").trim();
      const turningOffAutoRenew = parsedAutoRenew === false && order.autoRenew !== false;
      const leavingPaid =
        status != null &&
        status !== order.status &&
        order.status === "paid" &&
        ["cancelled", "expired", "failed"].includes(status);
      const shouldStopGateway =
        (turningOffAutoRenew || leavingPaid) &&
        order.paymentMethod === PAYMENT_METHOD.CREDIT_CARD &&
        Boolean(acidBefore) &&
        !order.stopRequested;

      await order.update(updates);
      if (shouldStopGateway) {
        const aid = String(process.env.JPAYMENT_AID || "").trim();
        const stopResult = await stopLegacyAutoCharge({
          aid,
          legacyForStop: {
            acid: acidBefore,
            legacyOrderId: order.id,
            userId: order.userId,
          },
          source: "admin/upsert-payment",
          expectedUserId: order.userId,
        });
        if (!stopResult.ok) {
          console.error("[ADMIN PAYMENT] auto-charge stop failed; retry scheduled", {
            orderId: order.id,
            userId: order.userId,
            reason: stopResult.reason || null,
          });
        }
      }
      await order.reload();
    }
    await refreshAndSyncUserSubscriptionState(targetUser.id);

    return res.json({
      message: "Payment package updated by admin",
      user: targetUser,
      payment: toPaymentProfilePayload(order),
      paymentMethodOptions: PAYMENT_METHOD_OPTIONS,
    });
  } catch (err) {
    console.error("❌ adminUpsertUserPayment error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

// Admin quick toggle for autoRenew on current user subscription
export async function adminSetUserAutoRenew(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    const parsedAutoRenew = parseAutoRenewOrNull(req.body?.autoRenew);
    if (parsedAutoRenew == null) {
      return res.status(400).json({ error: "autoRenew must be boolean (true/false)" });
    }

    const targetUser = await User.findByPk(userId, {
      attributes: ["id", "name", "email", "role", "status"],
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const order = await PaymentOrder.findOne({
      where: { userId, status: "paid" },
      order: [["createdAt", "DESC"]],
    });
    if (!order) {
      return res.status(404).json({ error: "No active paid subscription found for user" });
    }

    const acid = String(order.recurringToken || "").trim();
    const needsGatewayStop =
      parsedAutoRenew === false &&
      order.paymentMethod === PAYMENT_METHOD.CREDIT_CARD &&
      Boolean(acid) &&
      !order.stopRequested;

    await order.update({ autoRenew: parsedAutoRenew });

    let autoRenewStop = null;
    if (needsGatewayStop) {
      const aid = String(process.env.JPAYMENT_AID || "").trim();
      autoRenewStop = await stopLegacyAutoCharge({
        aid,
        legacyForStop: { acid, legacyOrderId: order.id, userId: order.userId },
        source: "admin/set-auto-renew",
        expectedUserId: order.userId,
      });
    } else if (
      parsedAutoRenew === false &&
      order.paymentMethod === PAYMENT_METHOD.CREDIT_CARD &&
      !acid
    ) {
      console.warn("[ADMIN AUTO_RENEW] no acid; local flag only", { orderId: order.id, userId });
    }

    await order.reload();
    await refreshAndSyncUserSubscriptionState(targetUser.id);

    if (autoRenewStop && autoRenewStop.ok === false) {
      return res.status(502).json({
        error: "Auto renew flag was updated, but stopping auto-charge at the gateway failed. A retry was scheduled.",
        stopRetryScheduled: Boolean(autoRenewStop.retryLater),
        autoRenewStop,
        user: targetUser,
        payment: toPaymentProfilePayload(order),
      });
    }

    return res.json({
      message: "Auto renew updated",
      user: targetUser,
      payment: toPaymentProfilePayload(order),
      ...(autoRenewStop ? { autoRenewStop } : {}),
    });
  } catch (err) {
    console.error("❌ adminSetUserAutoRenew error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/** Admin: list all payment_orders for one user (newest first). */
export async function adminListUserPaymentOrders(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const targetUser = await User.findByPk(userId, {
      attributes: ["id", "name", "email", "role", "status"],
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const orders = await PaymentOrder.findAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      user: targetUser,
      total: orders.length,
      items: orders.map((o) => toPaymentProfilePayload(o)),
    });
  } catch (err) {
    console.error("❌ adminListUserPaymentOrders error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * Admin: insert a new payment_orders row for an existing user (new subscription cycle).
 * BANK_TRANSFER / FREE only. CREDIT_CARD uses POST /api/payment/checkout/init + J-Payment.
 * Always assigns a new subscriptionId. When status is paid, every other paid row for this user
 * is expired immediately (including contracts still inside periodEndAt) so only one paid contract applies.
 */
export async function adminCreateManualPaymentOrderForUser(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const targetUser = await User.findByPk(userId, {
      attributes: ["id", "name", "email", "role", "status"],
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const body = req.body || {};
    const parsedMethod = parsePaymentMethod(body.paymentMethod);
    if (
      !parsedMethod ||
      ![PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.FREE].includes(parsedMethod)
    ) {
      return res.status(400).json({
        error:
          "paymentMethod must be BANK_TRANSFER or FREE. CREDIT_CARD uses /api/payment/checkout/init and J-Payment callbacks.",
      });
    }

    const planType = body.planType;
    const accountType = body.accountType;
    if (!planType || !["monthly", "yearly", "trial"].includes(planType)) {
      return res.status(400).json({ error: "planType must be monthly, yearly, or trial" });
    }
    if (!accountType || !["personal", "company"].includes(accountType)) {
      return res.status(400).json({ error: "accountType must be personal or company" });
    }
    if (planType === "trial" && accountType !== "personal") {
      return res.status(400).json({ error: "trial plan only supports personal accountType" });
    }

    const status =
      body.status != null && String(body.status).trim() !== ""
        ? String(body.status).trim()
        : "paid";
    if (!["pending", "paid"].includes(status)) {
      return res.status(400).json({ error: "status must be pending or paid" });
    }

    const parsedAutoRenew = parseAutoRenewOrNull(body.autoRenew);
    if (body.autoRenew !== undefined && parsedAutoRenew == null) {
      return res.status(400).json({ error: "autoRenew must be boolean (true/false)" });
    }
    const autoRenew = parsedAutoRenew == null ? true : parsedAutoRenew;

    const periodStartAt =
      body.periodStartAt !== undefined
        ? parseNullableDateTime(body.periodStartAt)
        : new Date();
    const periodEndAt = parseNullableDateTime(body.periodEndAt, { endOfDayForDateOnly: true });
    if (!periodStartAt) {
      return res.status(400).json({ error: "periodStartAt must be valid datetime" });
    }
    if (!periodEndAt) {
      return res.status(400).json({ error: "periodEndAt is required and must be valid datetime" });
    }

    const expectedAmount = toIntOrNull(body.expectedAmount);
    const paidAmount = toIntOrNull(body.paidAmount);
    if (body.expectedAmount !== undefined && expectedAmount == null) {
      return res.status(400).json({ error: "expectedAmount must be a number" });
    }
    if (body.paidAmount !== undefined && paidAmount == null) {
      return res.status(400).json({ error: "paidAmount must be a number" });
    }

    const listPrice = getPlanAmount(planType, accountType);
    const resolvedExpected = expectedAmount ?? listPrice ?? 0;

    const paidAt =
      status === "paid"
        ? body.paidAt !== undefined
          ? parseNullableDateTime(body.paidAt)
          : new Date()
        : null;
    if (status === "paid" && body.paidAt !== undefined && !paidAt) {
      return res.status(400).json({ error: "paidAt must be valid datetime" });
    }

    const stopTargets = [];
    const created = await sequelize.transaction(async (t) => {
      const subscriptionId = makeSubscriptionId(userId);

      if (status === "paid") {
        const priorPaid = await PaymentOrder.findAll({
          where: { userId, status: "paid" },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        for (const prior of priorPaid) {
          const acid = String(prior.recurringToken || "").trim();
          if (
            prior.paymentMethod === PAYMENT_METHOD.CREDIT_CARD &&
            acid &&
            !prior.stopRequested
          ) {
            stopTargets.push({
              acid,
              tid: String(prior.gid || "").trim(),
              legacyOrderId: prior.id,
              userId: prior.userId,
            });
          }
        }
        if (priorPaid.length) {
          await PaymentOrder.update(
            {
              status: "expired",
              autoRenew: false,
              renewNextRetryAt: null,
            },
            {
              where: {
                userId,
                status: "paid",
              },
              transaction: t,
            }
          );
        }
      }

      const order = await PaymentOrder.create(
        {
          cod: makeAdminPaymentOrderCod(userId, accountType, planType),
          userId,
          paymentMethod: parsedMethod,
          planType,
          accountType,
          expectedAmount: resolvedExpected,
          autoRenew,
          subscriptionId,
          status,
          am: status === "paid" ? paidAmount ?? resolvedExpected : null,
          paidAt: status === "paid" ? paidAt || new Date() : null,
          periodStartAt,
          periodEndAt,
        },
        { transaction: t }
      );

      return order;
    });

    const aid = String(process.env.JPAYMENT_AID || "").trim();
    const supersededAutoChargeStops = await stopLegacyAutoCharges(stopTargets, {
      aid,
      source: "admin/create-manual-order",
      expectedUserId: Number(userId),
    });
    const stopFailed = supersededAutoChargeStops.some((r) => r && r.ok === false);
    if (stopFailed) {
      console.error("[ADMIN PAYMENT] superseded auto-charge stop failed; retry scheduled", {
        userId,
        failed: supersededAutoChargeStops.filter((r) => r && r.ok === false).length,
      });
    }

    await refreshAndSyncUserSubscriptionState(targetUser.id);

    return res.status(201).json({
      message: "Payment order created",
      user: targetUser,
      payment: toPaymentProfilePayload(created),
      paymentMethodOptions: PAYMENT_METHOD_OPTIONS,
      ...(supersededAutoChargeStops.length ? { supersededAutoChargeStops } : {}),
    });
  } catch (err) {
    console.error("❌ adminCreateManualPaymentOrderForUser error:", err);
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Duplicate key (e.g. renewal constraint)", details: err.message });
    }
    return res.status(500).json({ error: "Server error" });
  }
}

// Get flights for one user (including pilot from pilots table)
export async function getUserFlights(req, res) {
  try {
    const { userId } = req.params;
    const flights = await Flight.findAll({
      where: { userId },
      include: [{ model: Pilot, as: "Pilot", attributes: ["id", "fullName", "organization", "certificateType", "certificateNumber", "expiredDate"] }],
      order: [["takeoffTime", "DESC"]],
    });
    res.json({ flights });
  } catch (err) {
    console.error("❌ getUserFlights error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function getUserMaintenances(req, res) {
  try {
    const { userId } = req.params;
    const maintenances = await Maintenance.findAll({
      where: { userId },
      order: [["date", "DESC"]],
    });
    res.json({ maintenances });
  } catch (err) {
    console.error("❌ getUserMaintenances error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

// Overall admin statistics
export async function getAdminStats(req, res) {
  try {
    const totalUsers = await User.count({ where: { role: "user" } });
    const totalAdmins = await User.count({ where: { role: "admin" } });
    const totalFlights = await Flight.count();
    const totalMaintenances = await Maintenance.count();

    // Monthly flight stats (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const [monthlyStats] = await sequelize.query(`
      SELECT 
        DATE_FORMAT(takeoffTime, '%Y-%m') as month,
        COUNT(*) as count
      FROM flights
      WHERE takeoffTime >= ?
      GROUP BY DATE_FORMAT(takeoffTime, '%Y-%m')
      ORDER BY month ASC
    `, {
      replacements: [sixMonthsAgo],
    });

    res.json({
      stats: {
        totalUsers,
        totalAdmins,
        totalFlights,
        totalMaintenances,
      },
      monthlyStats,
    });
  } catch (err) {
    console.error("❌ getAdminStats error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

// Admin payments table: filter + pagination + sorting
export async function getAdminPayments(req, res) {
  try {
    const userId = toIntOrNull(req.query.userId);
    const page = parsePositiveInt(req.query.page, 1);
    // One-user view: default / cap higher so history (expired/cancelled renewals) fits one response.
    const defaultLimit = userId != null ? 1000 : 20;
    const maxLimit = userId != null ? 5000 : 100;
    const limit = Math.min(parsePositiveInt(req.query.limit, defaultLimit), maxLimit);
    const offset = (page - 1) * limit;

    const sortByAllowed = new Set(["createdAt", "paidAt", "periodEndAt", "expectedAmount", "am", "status"]);
    const sortBy = sortByAllowed.has(String(req.query.sortBy || "")) ? String(req.query.sortBy) : "createdAt";
    const sortDir = String(req.query.sortDir || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const where = {};
    const status = req.query.status != null ? String(req.query.status).trim() : "";
    const paymentMethodFilter =
      req.query.paymentMethod != null ? String(req.query.paymentMethod).trim() : "";
    const planType = req.query.planType != null ? String(req.query.planType).trim() : "";
    const accountType = req.query.accountType != null ? String(req.query.accountType).trim() : "";
    const cod = req.query.cod != null ? String(req.query.cod).trim() : "";
    const dateFrom = req.query.dateFrom != null ? String(req.query.dateFrom).trim() : "";
    const dateTo = req.query.dateTo != null ? String(req.query.dateTo).trim() : "";
    const keyword = req.query.keyword != null ? String(req.query.keyword).trim() : "";

    if (status) where.status = status;
    const pmParsed = paymentMethodFilter ? parsePaymentMethod(paymentMethodFilter) : null;
    if (pmParsed) where.paymentMethod = pmParsed;
    if (planType) where.planType = planType;
    if (accountType) where.accountType = accountType;
    if (cod) where.cod = { [Op.like]: `%${cod}%` };
    if (userId != null) where.userId = userId;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
      if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59.999`);
    }

    const include = [
      {
        model: User,
        attributes: ["id", "name", "email", "role", "subscriptionPlan"],
        required: false,
      },
    ];
    if (keyword) {
      include[0].required = true;
      include[0].where = {
        [Op.or]: [
          { name: { [Op.like]: `%${keyword}%` } },
          { email: { [Op.like]: `%${keyword}%` } },
        ],
      };
    }

    const { rows, count } = await PaymentOrder.findAndCountAll({
      where,
      include,
      distinct: true,
      order: [[sortBy, sortDir]],
      limit,
      offset,
    });

    return res.json({
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      paymentMethodOptions: PAYMENT_METHOD_OPTIONS,
      filters: {
        status: status || null,
        paymentMethod: paymentMethodFilter || null,
        planType: planType || null,
        accountType: accountType || null,
        userId: userId ?? null,
        cod: cod || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        keyword: keyword || null,
      },
      items: rows.map((order) => ({
        ...toPaymentProfilePayload(order),
        user: order.User
          ? {
            id: order.User.id,
            name: order.User.name,
            email: order.User.email,
            role: order.User.role,
            subscriptionPlan: order.User.subscriptionPlan || "none",
          }
          : null,
        // Admin screen may need callback/raw fields for reconciliation.
        gateway: {
          gid: order.gid ?? null,
          god: order.god ?? null,
          rst: order.rst ?? null,
          ec: order.ec ?? null,
          ap: order.ap ?? null,
          tx: order.tx ?? null,
          sf: order.sf ?? null,
          ta: order.ta ?? null,
          rawParams: order.rawParams ?? null,
        },
      })),
    });
  } catch (err) {
    console.error("❌ getAdminPayments error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// Admin payment cancellations table: filter + pagination + sorting
export async function getAdminPaymentCancellations(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 20), 100);
    const offset = (page - 1) * limit;

    const sortByAllowed = new Set(["createdAt", "updatedAt", "id"]);
    const sortBy = sortByAllowed.has(String(req.query.sortBy || "")) ? String(req.query.sortBy) : "createdAt";
    const sortDir = String(req.query.sortDir || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const where = {};
    const userId = toIntOrNull(req.query.userId);
    const paymentOrderId = toIntOrNull(req.query.paymentOrderId);
    const cod = req.query.cod != null ? String(req.query.cod).trim() : "";
    const planType = req.query.planType != null ? String(req.query.planType).trim() : "";
    const accountType = req.query.accountType != null ? String(req.query.accountType).trim() : "";
    const dateFrom = req.query.dateFrom != null ? String(req.query.dateFrom).trim() : "";
    const dateTo = req.query.dateTo != null ? String(req.query.dateTo).trim() : "";
    const keyword = req.query.keyword != null ? String(req.query.keyword).trim() : "";

    if (userId != null) where.userId = userId;
    if (paymentOrderId != null) where.paymentOrderId = paymentOrderId;
    if (cod) where.cod = { [Op.like]: `%${cod}%` };
    if (planType) where.planType = planType;
    if (accountType) where.accountType = accountType;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
      if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59.999`);
    }

    const include = [
      {
        model: User,
        attributes: ["id", "name", "email", "role", "subscriptionPlan"],
        required: false,
      },
      {
        model: PaymentOrder,
        attributes: ["id", "cod", "status", "paymentMethod", "planType", "accountType", "createdAt", "paidAt"],
        required: false,
      },
    ];

    if (keyword) {
      include[0].required = true;
      include[0].where = {
        [Op.or]: [
          { name: { [Op.like]: `%${keyword}%` } },
          { email: { [Op.like]: `%${keyword}%` } },
        ],
      };
    }

    const { rows, count } = await UserPaymentCancellation.findAndCountAll({
      where,
      include,
      distinct: true,
      order: [[sortBy, sortDir]],
      limit,
      offset,
    });

    // paymentOrderId có thể null với flow mới (chỉ gửi reason),
    // nên lấy thêm đơn paid gần nhất theo user để map "ngày mua".
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id) => id != null))];
    const latestPaidByUserId = new Map();
    if (userIds.length > 0) {
      const latestPaidOrders = await PaymentOrder.findAll({
        where: {
          userId: { [Op.in]: userIds },
          status: "paid",
        },
        attributes: ["id", "userId", "cod", "status", "paymentMethod", "planType", "accountType", "createdAt", "paidAt"],
        order: [["userId", "ASC"], ["paidAt", "DESC"], ["createdAt", "DESC"]],
      });
      for (const order of latestPaidOrders) {
        if (!latestPaidByUserId.has(order.userId)) {
          latestPaidByUserId.set(order.userId, order);
        }
      }
    }

    return res.json(removeNullFields({
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      filters: {
        userId: userId ?? null,
        paymentOrderId: paymentOrderId ?? null,
        cod: cod || null,
        planType: planType || null,
        accountType: accountType || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        keyword: keyword || null,
      },
      items: rows.map((row) => ({
        // Theo yêu cầu FE:
        // - updatedAt = ngày bấm hủy
        // - createdAt = ngày mua
        ...(function buildRow() {
          const purchaseOrder = row.PaymentOrder || latestPaidByUserId.get(row.userId) || null;
          const purchasedAt = purchaseOrder?.paidAt ?? purchaseOrder?.createdAt ?? row.createdAt;
          const cancelledAt = row.createdAt;
          return {
            id: row.id,
            userId: row.userId,
            paymentOrderId: row.paymentOrderId,
            cod: row.cod ?? purchaseOrder?.cod ?? null,
            planType: row.planType ?? purchaseOrder?.planType ?? null,
            accountType: row.accountType ?? purchaseOrder?.accountType ?? null,
            reason: row.note ?? null,
            meta: row.clientMeta ? (() => {
              try {
                return JSON.parse(row.clientMeta);
              } catch {
                return row.clientMeta;
              }
            })() : null,
            createdAt: purchasedAt ?? null,
            updatedAt: cancelledAt ?? null,
            user: row.User
              ? {
                id: row.User.id,
                name: row.User.name,
                email: row.User.email,
                role: row.User.role,
                subscriptionPlan: row.User.subscriptionPlan || "none",
              }
              : null,
            paymentOrder: purchaseOrder
              ? {
                id: purchaseOrder.id,
                cod: purchaseOrder.cod,
                status: purchaseOrder.status,
                paymentMethod: purchaseOrder.paymentMethod,
                planType: purchaseOrder.planType,
                accountType: purchaseOrder.accountType,
                paidAt: purchaseOrder.paidAt ?? null,
                createdAt: purchaseOrder.createdAt,
              }
              : null,
          };
        })(),
      })),
    }));
  } catch (err) {
    console.error("❌ getAdminPaymentCancellations error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// Admin: delete one cancellation log row
export async function deleteAdminPaymentCancellation(req, res) {
  try {
    const id = toIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ error: "Invalid id" });

    const row = await UserPaymentCancellation.findByPk(id);
    if (!row) return res.status(404).json({ error: "Payment cancellation not found" });

    await row.destroy();
    return res.json({ message: "Payment cancellation deleted", id });
  } catch (err) {
    console.error("❌ deleteAdminPaymentCancellation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// Create user (admin only)
export async function createUser(req, res) {
  try {
    const { name, email, password, role, status: rawStatus } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing required fields: name, email, password" });
    }

    // Check if email already exists
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Validate role if provided
    if (role && !["admin", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be 'admin' or 'user'" });
    }

    const status = rawStatus === undefined ? USER_STATUS.ACTIVE : parseUserStatus(rawStatus);
    if (!status) {
      return res.status(400).json({ error: "Invalid status. Must be 'active' or 'suspended'" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new user
    const newUser = await User.create({
      name,
      email,
      password: hashedPassword,
      role: role || "user",
      status,
    });

    res.status(201).json({
      message: "User created successfully",
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        status: newUser.status,
        createdAt: newUser.createdAt,
      },
    });
  } catch (err) {
    console.error("❌ createUser error:", err);
    if (err.name === "SequelizeValidationError") {
      return res.status(400).json({ error: "Validation error", details: err.errors });
    }
    res.status(500).json({ error: "Server error" });
  }
}

// Admin creates user with manual paid package (BANK_TRANSFER/FREE)
export async function adminCreateUserWithManualPayment(req, res) {
  try {
    const {
      name,
      email,
      password,
      role,
      status: rawStatus,
      paymentMethod,
      planType,
      accountType,
    } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing required fields: name, email, password" });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    if (role && !["admin", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be 'admin' or 'user'" });
    }

    const status = rawStatus === undefined ? USER_STATUS.ACTIVE : parseUserStatus(rawStatus);
    if (!status) {
      return res.status(400).json({ error: "Invalid status. Must be 'active' or 'suspended'" });
    }

    const parsedPaymentMethod = parsePaymentMethod(paymentMethod);
    if (
      !parsedPaymentMethod ||
      ![PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.FREE].includes(parsedPaymentMethod)
    ) {
      return res.status(400).json({
        error: "paymentMethod must be BANK_TRANSFER/FREE (銀行振込/決済免除)",
      });
    }

    if (!planType || !["monthly", "yearly", "trial"].includes(planType)) {
      return res.status(400).json({ error: "planType must be monthly, yearly, or trial" });
    }
    if (!accountType || !["personal", "company"].includes(accountType)) {
      return res.status(400).json({ error: "accountType must be personal or company" });
    }

    const expectedAmount = toIntOrNull(req.body?.expectedAmount);
    const paidAmount = toIntOrNull(req.body?.paidAmount);
    const periodStartAt =
      req.body?.periodStartAt !== undefined
        ? parseNullableDateTime(req.body?.periodStartAt)
        : new Date();
    const periodEndAt = parseNullableDateTime(req.body?.periodEndAt, {
      endOfDayForDateOnly: true,
    });
    const paidAt =
      req.body?.paidAt !== undefined ? parseNullableDateTime(req.body?.paidAt) : new Date();

    if (!periodStartAt) {
      return res.status(400).json({ error: "periodStartAt must be valid datetime" });
    }
    if (!periodEndAt) {
      return res.status(400).json({ error: "periodEndAt is required and must be valid datetime" });
    }
    if (req.body?.expectedAmount !== undefined && expectedAmount == null) {
      return res.status(400).json({ error: "expectedAmount must be a number" });
    }
    if (req.body?.paidAmount !== undefined && paidAmount == null) {
      return res.status(400).json({ error: "paidAmount must be a number" });
    }
    if (req.body?.paidAt !== undefined && !paidAt) {
      return res.status(400).json({ error: "paidAt must be valid datetime" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const created = await sequelize.transaction(async (t) => {
      const newUser = await User.create(
        {
          name,
          email,
          password: hashedPassword,
          role: role || "user",
          status,
        },
        { transaction: t }
      );

      const createdPayment = await PaymentOrder.create(
        {
          cod: makeAdminManualCod(newUser.id, accountType, planType),
          userId: newUser.id,
          paymentMethod: parsedPaymentMethod,
          planType,
          accountType,
          expectedAmount: expectedAmount ?? 0,
          autoRenew: false,
          subscriptionId: makeSubscriptionId(newUser.id),
          status: "paid",
          am: paidAmount ?? expectedAmount ?? 0,
          paidAt,
          periodStartAt,
          periodEndAt,
        },
        { transaction: t }
      );

      return { newUser, createdPayment };
    });

    await refreshAndSyncUserSubscriptionState(created.newUser.id);

    return res.status(201).json({
      message: "User created successfully with manual subscription package",
      user: {
        id: created.newUser.id,
        name: created.newUser.name,
        email: created.newUser.email,
        role: created.newUser.role,
        status: created.newUser.status,
        createdAt: created.newUser.createdAt,
      },
      payment: toPaymentProfilePayload(created.createdPayment),
      paymentMethodOptions: PAYMENT_METHOD_OPTIONS,
    });
  } catch (err) {
    console.error("❌ adminCreateUserWithManualPayment error:", err);
    if (err.name === "SequelizeValidationError") {
      return res.status(400).json({ error: "Validation error", details: err.errors });
    }
    return res.status(500).json({ error: "Server error" });
  }
}

// Delete user (admin only)
export async function deleteUser(req, res) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Prevent deleting your own account
    if (String(userId) === String(req.user.id)) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Delete user (cascade removes related records if FK constraints exist)
    await user.destroy();

    res.json({
      message: "User deleted successfully",
      deletedUser: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (err) {
    console.error("❌ deleteUser error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

// Login as user (admin only) - allow admin impersonation
export async function loginAsUser(req, res) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Find target user
    const targetUser = await User.findByPk(userId, {
      attributes: { exclude: ["password", "resetCode", "resetExpire"] },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Disallow impersonating another admin (security)
    if (targetUser.role === "admin") {
      return res.status(403).json({ 
        error: "Cannot login as another admin. This feature is only for regular users." 
      });
    }
    if (isUserSuspended(targetUser)) {
      return sendSuspendedAccountResponse(res);
    }

    // Generate token with impersonation metadata
    const token = generateToken({
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      role: targetUser.role || "user",
      isImpersonation: true,
      impersonatedBy: req.user.id
    });

    res.json({
      message: "Login as user successful",
      token,
      user: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role || "user",
        status: targetUser.status,
      },
      adminInfo: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
      },
    });
  } catch (err) {
    console.error("❌ loginAsUser error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function updateUserStatus(req, res) {
  try {
    const { userId } = req.params;
    const nextStatus = parseUserStatus(req.body?.status);

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    if (!nextStatus) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
    }
    if (String(userId) === String(req.user.id) && nextStatus === USER_STATUS.SUSPENDED) {
      return res.status(400).json({ error: "Cannot suspend your own account" });
    }

    const user = await User.findByPk(userId, {
      attributes: { exclude: ["password", "resetCode", "resetExpire"] },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.status !== nextStatus) {
      user.status = nextStatus;
      await user.save();
    }

    return res.json({
      message:
        nextStatus === USER_STATUS.SUSPENDED
          ? "User suspended successfully"
          : "User reactivated successfully",
      user,
    });
  } catch (err) {
    console.error("❌ updateUserStatus error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * Admin: refund (gateway.aspx jb=CANCEL) then stop recurring (acsgate cmd=1) when acid exists.
 *
 * POST /api/user/users/:userId/payment-orders/:orderId/gateway-refund
 */
export async function adminGatewayRefundPaymentOrder(req, res) {
  try {
    const userId = toIntOrNull(req.params.userId);
    const orderId = toIntOrNull(req.params.orderId);
    if (!userId) {
      return res.status(400).json({ error: "Invalid userId" });
    }
    if (!orderId) {
      return res.status(400).json({ error: "Invalid orderId" });
    }

    const order = await PaymentOrder.findByPk(orderId);
    if (!order) {
      return res.status(404).json({ error: "Payment order not found" });
    }
    if (order.userId == null || Number(order.userId) !== userId) {
      return res.status(404).json({ error: "Payment order does not belong to this user" });
    }

    if (order.paymentMethod !== PAYMENT_METHOD.CREDIT_CARD) {
      return res.status(400).json({
        error: "Gateway refund applies to CREDIT_CARD orders only",
        paymentMethod: order.paymentMethod,
      });
    }

    if (order.status !== "paid") {
      return res.status(400).json({
        error: "Only paid orders can be refunded via the payment gateway",
        status: order.status,
      });
    }

    const tid = String(order.gid || "").trim();
    if (!tid) {
      return res.status(400).json({
        error: "Missing gateway transaction id (gid) on this order; cannot call jb=CANCEL",
      });
    }

    const aid = String(process.env.JPAYMENT_AID || "").trim();
    if (!aid) {
      return res.status(500).json({ error: "JPAYMENT_AID is not set" });
    }

    const gatewayResult = await cancelGatewayTransaction({ aid, tid });
    const { parsed } = gatewayResult;

    if (!parsed?.success) {
      console.error("[GATEWAY_REFUND] cancel failed", {
        orderId: order.id,
        userId: order.userId,
        tid,
        httpStatus: gatewayResult.httpStatus,
        format: parsed?.format,
        errorCode: parsed?.errorCode,
        rst: parsed?.rst,
        ec: parsed?.ec,
        snippet: gatewayResult.responseSnippet,
      });
      return res.status(502).json({
        error: "Payment gateway cancel (refund) failed",
        gateway: {
          httpStatus: gatewayResult.httpStatus,
          format: parsed?.format ?? null,
          errorCode: parsed?.errorCode ?? null,
          rst: parsed?.rst ?? null,
          ec: parsed?.ec ?? null,
          responseSnippet: gatewayResult.responseSnippet,
        },
      });
    }

    const acid = String(order.recurringToken || "").trim();
    let autoRenewStop;

    if (!acid) {
      autoRenewStop = {
        attempted: false,
        ok: null,
        skipped: true,
        reason: "no_recurring_token_on_order",
        reasonDetail:
          "payment_orders.recurringToken (J-Payment acid) is empty — acsgate stop was not called. " +
          "Typical if this order never registered auto-charge (manual/admin) or callback did not return acid.",
        errorCode: null,
        httpStatus: null,
        responseSnippet: null,
        duplicateStop: false,
        acidMasked: null,
      };
      console.warn("[GATEWAY_REFUND][AUTO_RENEW_STOP_SKIPPED]", {
        action: "AUTO_RENEW_STOP",
        orderId: order.id,
        userId: order.userId,
        cod: order.cod,
        paymentMethod: order.paymentMethod,
        autoRenew: order.autoRenew,
        stopRequested: order.stopRequested,
        ...autoRenewStop,
      });
    } else {
      autoRenewStop = await stopLegacyAutoCharge({
        aid,
        legacyForStop: { acid, legacyOrderId: order.id, userId: order.userId },
        source: "admin/gateway-refund",
        expectedUserId: order.userId,
      });
      if (autoRenewStop.ok) {
        console.log("[GATEWAY_REFUND][AUTO_RENEW_STOP_OK]", {
          action: "AUTO_RENEW_STOP",
          orderId: order.id,
          userId: order.userId,
          acidMasked: autoRenewStop.acidMasked ?? maskJPaymentAcid(acid),
          reason: autoRenewStop.reason,
          reasonDetail: autoRenewStop.reasonDetail,
          duplicateStop: autoRenewStop.duplicateStop,
          httpStatus: autoRenewStop.httpStatus,
        });
      }
    }

    const stopFailed = autoRenewStop.attempted && !autoRenewStop.ok;

    const refundNote = {
      source: "admin_gateway_refund",
      jb: "CANCEL",
      tid,
      at: new Date().toISOString(),
      gateway: parsed,
      autoRenewStop,
    };

    let previousRaw = null;
    try {
      previousRaw = order.rawParams ? JSON.parse(order.rawParams) : null;
    } catch {
      previousRaw = order.rawParams;
    }

    await order.update({
      status: "cancelled",
      cancelledAt: new Date(),
      autoRenew: false,
      stopRequested: autoRenewStop.ok ? true : order.stopRequested,
      stopRequestedAt: autoRenewStop.ok ? new Date() : order.stopRequestedAt,
      rst: parsed.rst ?? order.rst,
      ec: parsed.ec || null,
      ap: parsed.ap || order.ap,
      gid: parsed.gid || order.gid,
      rawParams: JSON.stringify({
        ...(typeof previousRaw === "object" && previousRaw !== null ? previousRaw : {}),
        gatewayRefund: refundNote,
      }),
      renewFailureCode: stopFailed ? "GATEWAY_REFUNDED_STOP_FAILED" : "GATEWAY_REFUNDED",
      renewNextRetryAt: stopFailed ? nextJstDateOnlyString() : null,
    });

    await order.reload();

    if (order.userId) {
      await refreshAndSyncUserSubscriptionState(order.userId);
    }

    const payload = {
      order: toPaymentProfilePayload(order),
      gateway: {
        tid,
        cancelGid: parsed.gid ?? null,
        rst: parsed.rst,
        ap: parsed.ap ?? null,
        ec: parsed.ec ?? null,
      },
      autoRenewStop,
      refundCompleted: true,
    };

    if (stopFailed) {
      console.error("[GATEWAY_REFUND][AUTO_RENEW_STOP_FAILED]", {
        action: "AUTO_RENEW_STOP",
        orderId: order.id,
        userId: order.userId,
        cod: order.cod,
        acidMasked: autoRenewStop.acidMasked ?? maskJPaymentAcid(acid),
        reason: autoRenewStop.reason,
        reasonDetail: autoRenewStop.reasonDetail,
        errorCode: autoRenewStop.errorCode ?? null,
        httpStatus: autoRenewStop.httpStatus ?? null,
        duplicateStop: autoRenewStop.duplicateStop ?? false,
        gatewayResponse: autoRenewStop.responseSnippet ?? null,
        refundTid: tid,
        aidConfigured: Boolean(aid),
      });
      return res.status(502).json({
        error: "返金は成功しましたが、決済ゲートウェイでの自動更新の停止に失敗しました",
        stopFailureReason: autoRenewStop.reason,
        stopFailureDetail: autoRenewStop.reasonDetail,
        ...payload,
      });
    }

    return res.json({
      message: acid
        ? "返金され、自動更新も正常に停止されました"
        : "返金（決済ゲートウェイのキャンセル）が正常に完了しました",
      ...payload,
    });
  } catch (err) {
    console.error("❌ adminGatewayRefundPaymentOrder error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
