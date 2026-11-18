import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildAutoRenewResultPatch, classifyAutoRenewRst } from "../src/utils/autoRenewRst.js";
import { parseJstDateTime } from "../src/utils/jstDate.js";
import {
  extractJPaymentErCode,
  interpretAutoChargeStopBody,
  stopJPaymentAutoCharge,
} from "../src/utils/jpaymentGateway.js";
import {
  assertJPaymentCallbackSecretConfigured,
  redactPaymentCallbackQuery,
  redactPaymentCallbackUrl,
  verifyJPaymentCallbackQuerySecret,
} from "../src/utils/paymentNotify.js";

const ORIGINAL_SECRET = process.env.JPAYMENT_CALLBACK_QUERY_SECRET;
const ORIGINAL_TIMEOUT = process.env.JPAYMENT_GATEWAY_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.JPAYMENT_CALLBACK_QUERY_SECRET;
  else process.env.JPAYMENT_CALLBACK_QUERY_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.JPAYMENT_GATEWAY_TIMEOUT_MS;
  else process.env.JPAYMENT_GATEWAY_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

function withSecret(secret) {
  if (secret == null || secret === "") delete process.env.JPAYMENT_CALLBACK_QUERY_SECRET;
  else process.env.JPAYMENT_CALLBACK_QUERY_SECRET = secret;
}

describe("callback secret", () => {
  it("refuses to run when the secret is missing", () => {
    withSecret("");
    assert.throws(() => assertJPaymentCallbackSecretConfigured(), /JPAYMENT_CALLBACK_QUERY_SECRET is required/);
  });

  it("accepts the secret from the path or the s query and rejects anything else", () => {
    withSecret("notify-secret-value");
    assert.doesNotThrow(() =>
      verifyJPaymentCallbackQuerySecret({ params: { notifyToken: "notify-secret-value" }, query: {} })
    );
    assert.doesNotThrow(() =>
      verifyJPaymentCallbackQuerySecret({ params: {}, query: { s: "notify-secret-value", gid: "1" } })
    );
    assert.throws(
      () => verifyJPaymentCallbackQuerySecret({ params: {}, query: { s: "wrong", gid: "1", rst: "1" } }),
      (err) => err.statusCode === 403
    );
    assert.throws(
      () => verifyJPaymentCallbackQuerySecret({ params: {}, query: { gid: "1", rst: "1" } }),
      (err) => err.statusCode === 403
    );
  });
});

describe("callback secret redaction", () => {
  it("removes the secret from urls and query objects", () => {
    withSecret("notify-secret-value");
    const url = redactPaymentCallbackUrl(
      "/api/payment/callback/notify-secret-value?gid=9&rst=1&s=notify-secret-value"
    );
    assert.equal(url.includes("notify-secret-value"), false);
    assert.match(url, /\/callback\/\[REDACTED\]/);
    assert.match(url, /s=\[REDACTED\]/);

    const autoRenewUrl = redactPaymentCallbackUrl(
      "/api/payment/auto-renew/callback/notify-secret-value?gid=9"
    );
    assert.equal(autoRenewUrl.includes("notify-secret-value"), false);

    const query = redactPaymentCallbackQuery({
      s: "notify-secret-value",
      gid: "9",
      rst: "1",
      cod: "ORD_1",
    });
    assert.equal(query.s, "[REDACTED]");
    assert.equal(query.gid, "9");
    assert.equal(JSON.stringify(query).includes("notify-secret-value"), false);
  });
});

describe("auto-charge rst", () => {
  const order = { recurringToken: "acid1", autoRenew: true, status: "paid", cancelledAt: null, renewRetryCount: 1 };

  it("keeps renewal enabled on success and on retryable failure", () => {
    assert.equal(classifyAutoRenewRst("1").keepAutoRenew, true);
    assert.equal(classifyAutoRenewRst("3").outcome, "retryable_failure");
    assert.equal(classifyAutoRenewRst("3").keepAutoRenew, true);

    const retry = buildAutoRenewResultPatch(order, { rst: "3", acid: "acid1", ec: "G12", gid: "99" });
    assert.equal(retry.patch.autoRenew, true);
    assert.equal(retry.patch.status, "paid");
    assert.equal(retry.patch.cancelledAt, null);
    assert.equal(retry.patch.renewFailureCode, "G12");
    assert.equal(retry.patch.renewRetryCount, 2);

    const success = buildAutoRenewResultPatch(
      { ...order, renewRetryCount: 2 },
      { rst: "1", acid: "acid1", gid: "100" }
    );
    assert.equal(success.classified.outcome, "success");
    assert.equal(success.patch.autoRenew, true);
    assert.equal(success.patch.renewFailureCode, null);
    assert.equal(success.patch.renewRetryCount, 0);
    assert.equal(success.patch.status, "paid");
  });

  it("ends renewal only for final failure and stop codes", () => {
    for (const rst of ["2", "4", "5"]) {
      const built = buildAutoRenewResultPatch(order, { rst, acid: "acid1" });
      assert.equal(built.patch.autoRenew, false, rst);
    }
    assert.equal(classifyAutoRenewRst("2").cancelSubscription, false);
    assert.equal(classifyAutoRenewRst("4").cancelSubscription, true);
    assert.equal(classifyAutoRenewRst("5").cancelSubscription, false);
    assert.equal(classifyAutoRenewRst("9").outcome, "ignored");
    assert.equal(buildAutoRenewResultPatch(order, { rst: "9" }), null);

    const stopped = buildAutoRenewResultPatch(order, { rst: "4", acid: "acid1" });
    assert.equal(stopped.patch.status, "cancelled");
    assert.ok(stopped.patch.cancelledAt instanceof Date);
  });

  it("does not store the notify secret on the order", () => {
    withSecret("notify-secret-value");
    const built = buildAutoRenewResultPatch(order, {
      rst: "3",
      acid: "acid1",
      s: "notify-secret-value",
    });
    assert.equal(built.patch.rawParams.includes("notify-secret-value"), false);
  });
});

describe("acsgate stop detection", () => {
  it("treats only OK as success and does not use a bare ER substring", () => {
    assert.equal(interpretAutoChargeStopBody("OK").ok, true);
    assert.equal(interpretAutoChargeStopBody("OK").reason, "stopped");
    assert.equal(interpretAutoChargeStopBody("  ok\n").ok, true);

    const empty = interpretAutoChargeStopBody("");
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "empty_gateway_response");

    const blank = interpretAutoChargeStopBody("   ");
    assert.equal(blank.ok, false);

    const user = interpretAutoChargeStopBody("USER ORDER SERVER");
    assert.equal(user.ok, false);
    assert.equal(user.reason, "unknown_stop_failure");
    assert.equal(extractJPaymentErCode("USER ORDER SERVER"), null);

    const er = interpretAutoChargeStopBody("ER003");
    assert.equal(er.ok, false);
    assert.equal(er.reason, "gateway_er");
    assert.equal(er.errorCode, "ER003");

    const already = interpretAutoChargeStopBody("ER024");
    assert.equal(already.ok, true);
    assert.equal(already.reason, "already_stopped");

    const duplicate = interpretAutoChargeStopBody("既に停止済み");
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicateStop, true);
  });

  it("times out and does not treat an empty HTTP 200 as stopped", async () => {
    const originalFetch = globalThis.fetch;
    process.env.JPAYMENT_GATEWAY_TIMEOUT_MS = "50";
    try {
      globalThis.fetch = async () => new Response("", { status: 200 });
      const empty = await stopJPaymentAutoCharge({ aid: "100000", acid: "1234567" });
      assert.equal(empty.ok, false);
      assert.equal(empty.reason, "empty_gateway_response");

      globalThis.fetch = async () => new Response("OK", { status: 200 });
      const ok = await stopJPaymentAutoCharge({ aid: "100000", acid: "1234567" });
      assert.equal(ok.ok, true);
      assert.equal(ok.reason, "stopped");

      globalThis.fetch = async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      };
      const timedOut = await stopJPaymentAutoCharge({ aid: "100000", acid: "1234567" });
      assert.equal(timedOut.ok, false);
      assert.equal(timedOut.reason, "timeout");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("JST datetime parsing", () => {
  it("reads MySQL JST wall-clock strings as JST even if the process is not in Tokyo", () => {
    const start = parseJstDateTime("2026-06-15 00:00:00");
    assert.equal(start.toISOString(), "2026-06-14T15:00:00.000Z");

    const end = parseJstDateTime("2026-06-15", { endOfDayForDateOnly: true });
    assert.equal(end.toISOString(), "2026-06-15T14:59:59.999Z");

    const zoned = parseJstDateTime("2026-06-15T00:00:00Z");
    assert.equal(zoned.toISOString(), "2026-06-15T00:00:00.000Z");

    const offset = parseJstDateTime("2026-06-15T12:00:00+09:00");
    assert.equal(offset.toISOString(), "2026-06-15T03:00:00.000Z");
  });
});
