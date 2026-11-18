import { PaymentOrder } from "../models/paymentOrder.model.js";
import { getUserSubscriptionState } from "../middlewares/subscription.middleware.js";
import { PAYMENT_METHOD } from "../utils/paymentEnums.js";
import { jpayLinkAutoChargeUpdateUrl } from "../utils/jpaymentEndpoints.js";

async function resolveActiveCreditCardOrder(userId) {
  const subscription = await getUserSubscriptionState(userId, { forceRefresh: true });
  if (subscription.status !== "active" || !subscription.paymentOrderId) {
    return { error: { status: 404, body: { error: "No active subscription found" } } };
  }

  const order = await PaymentOrder.findByPk(subscription.paymentOrderId);
  if (!order || order.status !== "paid") {
    return { error: { status: 404, body: { error: "No active paid subscription found" } } };
  }
  if (order.paymentMethod !== PAYMENT_METHOD.CREDIT_CARD) {
    return {
      error: {
        status: 400,
        body: { error: "Card change is only available for credit card subscriptions" },
      },
    };
  }

  const recurringToken = String(order.recurringToken || "").trim();
  if (!recurringToken) {
    return {
      error: {
        status: 400,
        body: { error: "No recurring token (acid) on active subscription" },
      },
    };
  }

  return { order, recurringToken, subscription };
}

/**
 * GET /api/subscription/change-card
 * Returns gid + recurringToken from active paid credit-card order for J-Payment card change form.
 */
export async function getChangeCardInfo(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const resolved = await resolveActiveCreditCardOrder(userId);
    if (resolved.error) {
      return res.status(resolved.error.status).json(resolved.error.body);
    }

    const gid = String(resolved.order.gid || "").trim();
    if (!gid) {
      return res.status(400).json({ error: "Missing payment gateway identifiers on active subscription" });
    }

    return res.json({ gid, recurringToken: resolved.recurringToken });
  } catch (err) {
    console.error("❌ getChangeCardInfo error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * POST /api/subscription/change-card/init
 * Returns J-Payment link方式 URL — user updates card on J-Payment hosted page.
 */
export async function initChangeCard(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const resolved = await resolveActiveCreditCardOrder(userId);
    if (resolved.error) {
      return res.status(resolved.error.status).json(resolved.error.body);
    }

    const aid = String(process.env.JPAYMENT_AID || "").trim();
    if (!aid) {
      return res.status(500).json({ error: "JPAYMENT_AID is not set" });
    }

    const changeCardUrl = `${jpayLinkAutoChargeUpdateUrl()}?aid=${encodeURIComponent(aid)}`;

    return res.json({
      message: "Open changeCardUrl on J-Payment to update the credit card for auto-renew",
      changeCardUrl,
      aid,
      acid: resolved.recurringToken,
      gid: resolved.order.gid || null,
      recurringToken: resolved.recurringToken,
    });
  } catch (err) {
    console.error("❌ initChangeCard error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
