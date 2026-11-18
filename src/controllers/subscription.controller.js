import {
  getUserSubscriptionState,
  refreshAndSyncUserSubscriptionState,
} from "../middlewares/subscription.middleware.js";
import { PaymentOrder } from "../models/paymentOrder.model.js";
import { PAYMENT_METHOD } from "../utils/paymentEnums.js";
import { stopLegacyAutoCharge } from "../utils/autoChargeStop.js";

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

export async function getMySubscription(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const subscription = await getUserSubscriptionState(userId);
    return res.json({
      ...subscription,
      isActive: subscription.status === "active",
    });
  } catch (err) {
    console.error("❌ getMySubscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function setMyAutoRenew(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsedAutoRenew = parseAutoRenewOrNull(req.body?.autoRenew);
    if (parsedAutoRenew == null) {
      return res.status(400).json({ error: "autoRenew must be boolean (true/false)" });
    }

    const subscription = await getUserSubscriptionState(userId, { forceRefresh: true });
    if (subscription.status !== "active" || !subscription.paymentOrderId) {
      return res.status(404).json({ error: "No active subscription found" });
    }

    const activePaidOrder = await PaymentOrder.findByPk(subscription.paymentOrderId);
    if (!activePaidOrder || activePaidOrder.status !== "paid") {
      return res.status(404).json({ error: "No active paid subscription found" });
    }
    if (
      parsedAutoRenew === false &&
      activePaidOrder.paymentMethod === PAYMENT_METHOD.CREDIT_CARD &&
      activePaidOrder.autoRenew !== false
    ) {
      const aid = String(process.env.JPAYMENT_AID || "").trim();
      const acid = String(activePaidOrder.recurringToken || "").trim();
      if (!acid) {
        return res.status(400).json({ error: "No recurring token (acid) on active subscription" });
      }

      const stopResult = await stopLegacyAutoCharge({
        aid,
        legacyForStop: {
          acid,
          legacyOrderId: activePaidOrder.id,
          userId: activePaidOrder.userId,
        },
        source: "subscription/set-auto-renew",
        expectedUserId: userId,
      });
      if (!stopResult.ok) {
        console.error("[AUTO_RENEW] stop auto-charge failed", {
          userId,
          orderId: activePaidOrder.id,
          status: stopResult.status ?? stopResult.httpStatus ?? null,
          reason: stopResult.reason || null,
          responseSnippet: stopResult.snippet || stopResult.responseSnippet || null,
          retryLater: Boolean(stopResult.retryLater),
        });
        return res.status(502).json({
          error: "Failed to stop auto-renew at payment gateway",
          gatewayStatus: stopResult.status ?? stopResult.httpStatus ?? null,
          stopRetryScheduled: Boolean(stopResult.retryLater),
        });
      }
    }

    await activePaidOrder.update({ autoRenew: parsedAutoRenew });
    await activePaidOrder.reload();
    const refreshed = await refreshAndSyncUserSubscriptionState(userId);
    return res.json({
      message: "Auto renew updated",
      autoRenew: refreshed.autoRenew,
      subscription: refreshed,
    });
  } catch (err) {
    console.error("❌ setMyAutoRenew error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
