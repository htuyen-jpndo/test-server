import {
  getAutoChargeStopsDue,
  stopLegacyAutoCharge,
} from "../utils/autoChargeStop.js";

/**
 * Retries J-Payment acsgate stops that failed earlier.
 * Rows are selected by renewFailureCode + renewNextRetryAt (DATEONLY, JST).
 * Successful stop sets stopRequested and autoRenew=false.
 * Another failure pushes renewNextRetryAt to the next JST date.
 */
export async function runAutoChargeStopRetryBatch() {
  const aid = String(process.env.JPAYMENT_AID || "").trim();
  const due = await getAutoChargeStopsDue(new Date());
  let stopped = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const result = await stopLegacyAutoCharge({
        aid,
        legacyForStop: {
          acid: String(row.recurringToken || "").trim(),
          legacyOrderId: row.id,
          userId: row.userId,
        },
        source: "auto-charge-stop-retry",
        expectedUserId: row.userId,
      });
      if (result?.ok) stopped += 1;
      else failed += 1;
    } catch (e) {
      failed += 1;
      console.error("[AUTO_CHARGE_STOP_RETRY] item failed", {
        orderId: row.id,
        message: e?.message || String(e),
      });
    }
  }
  if (due.length) {
    console.log("[AUTO_CHARGE_STOP_RETRY] batch done", {
      candidates: due.length,
      stopped,
      failed,
    });
  }
  return { candidates: due.length, stopped, failed };
}

let intervalId = null;
let running = false;

export function startAutoChargeStopRetryWorker() {
  const raw = String(process.env.PAYMENT_AUTO_CHARGE_STOP_RETRY_WORKER_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  const enabled = raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
  if (!enabled) {
    console.log("ℹ️ Auto-charge stop retry worker disabled");
    return;
  }
  const ms =
    Number(process.env.PAYMENT_AUTO_CHARGE_STOP_RETRY_INTERVAL_MS) ||
    Number(process.env.PAYMENT_AUTO_RENEW_INTERVAL_MS) ||
    300000;
  if (intervalId) clearInterval(intervalId);

  const tick = () => {
    if (running) return;
    running = true;
    runAutoChargeStopRetryBatch()
      .catch((e) => console.error("[AUTO_CHARGE_STOP_RETRY] interval error", e))
      .finally(() => {
        running = false;
      });
  };

  intervalId = setInterval(tick, ms);
  console.log(`✅ Auto-charge stop retry worker enabled (every ${ms}ms)`);
  tick();
}
