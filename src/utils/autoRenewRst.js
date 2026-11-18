import { redactPaymentCallbackQuery } from "./paymentNotify.js";

/**
 * J-Payment / Robot Payment link-method auto-charge kickback `rst`
 * (2nd charge onward — 自動課金結果通知).
 *
 * Documented in クレジットカード リンク方式 (自動課金決済) 接続仕様書 and
 * https://jpayment.zendesk.com/hc/ja/articles/201513497
 *
 *   1 決済成功
 *   2 決済失敗 — gateway stops auto-charge after the retry sequence
 *   3 リトライ有失敗 — gateway will charge again; do not disable renewal
 *   4 ユーザーによる自動課金停止
 *   5 お試し期間中のリトライ失敗で自動課金停止
 *
 * Usual failure sequence when retries are enabled: rst=3 → rst=3 → rst=2.
 * A later rst=1 is a successful retry and must still extend the subscription.
 */
export function classifyAutoRenewRst(rst) {
  const code = String(rst ?? "").trim();
  if (code === "1") {
    return { code, outcome: "success", keepAutoRenew: true, cancelSubscription: false };
  }
  if (code === "3") {
    return { code, outcome: "retryable_failure", keepAutoRenew: true, cancelSubscription: false };
  }
  if (code === "2") {
    return { code, outcome: "final_failure", keepAutoRenew: false, cancelSubscription: false };
  }
  if (code === "4") {
    return { code, outcome: "user_stop", keepAutoRenew: false, cancelSubscription: true };
  }
  if (code === "5") {
    return { code, outcome: "trial_stop", keepAutoRenew: false, cancelSubscription: false };
  }
  return { code, outcome: "ignored", keepAutoRenew: null, cancelSubscription: false };
}

/**
 * Fields written on the active subscription row when an auto-charge kickback arrives.
 * Returns null when `rst` is not an auto-charge result code.
 */
export function buildAutoRenewResultPatch(order, q, now = new Date()) {
  const rst = String(q?.rst || "").trim();
  const classified = classifyAutoRenewRst(rst);
  if (classified.outcome === "ignored") return null;

  const ec = q?.ec != null ? String(q.ec).trim() : null;
  const recurringToken = q?.acid != null ? String(q.acid).trim() : "";
  const isSuccess = classified.outcome === "success";

  return {
    classified,
    patch: {
      recurringToken: recurringToken || order.recurringToken,
      renewFailureCode: isSuccess ? null : ec || `AUTO_RENEW_RST_${rst}`,
      rawParams: JSON.stringify(redactPaymentCallbackQuery(q || {})),
      renewLastAttemptAt: now,
      renewRetryCount: isSuccess ? 0 : Number(order.renewRetryCount || 0) + 1,
      autoRenew: classified.keepAutoRenew ? order.autoRenew : false,
      status: classified.cancelSubscription ? "cancelled" : order.status,
      cancelledAt: classified.cancelSubscription ? order.cancelledAt || now : order.cancelledAt,
    },
  };
}
