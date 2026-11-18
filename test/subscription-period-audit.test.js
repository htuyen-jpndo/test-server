import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  assertReadOnlySql,
  auditSubscriptionRows,
  findingsToCsv,
  maskEmail,
} from "../src/utils/subscriptionPeriodAudit.js";

describe("subscription period audit", () => {
  it("masks email and rejects writes", () => {
    assert.equal(maskEmail("alice@example.com"), "a***@example.com");
    assert.equal(maskEmail(""), "***");
    assert.doesNotThrow(() => assertReadOnlySql("SELECT id FROM payment_orders"));
    assert.doesNotThrow(() => assertReadOnlySql("SET SESSION TRANSACTION READ ONLY"));
    assert.throws(() => assertReadOnlySql("UPDATE payment_orders SET status = 'expired'"), /non-read SQL/);
    assert.throws(() => assertReadOnlySql("INSERT INTO payment_orders (cod) VALUES ('x')"), /non-read SQL/);
  });

  it("flags month-end drift, a 9h shift, a missing acid, and a plan mismatch", () => {
    const now = new Date("2025-03-15T00:00:00Z");
    const findings = auditSubscriptionRows({
      now,
      users: [
        { id: 1, email: "drift@example.com", subscriptionPlan: "personal_monthly" },
        { id: 2, email: "shift@example.com", subscriptionPlan: "personal_monthly" },
        { id: 3, email: "token@example.com", subscriptionPlan: "personal_monthly" },
        { id: 4, email: "plan@example.com", subscriptionPlan: "none" },
      ],
      orders: [
        {
          id: 10,
          userId: 1,
          email: "drift@example.com",
          planType: "monthly",
          accountType: "personal",
          status: "expired",
          paymentMethod: "CREDIT_CARD",
          autoRenew: 1,
          recurringToken: "acid-1",
          subscriptionId: "SUB_DRIFT",
          sourceOrderId: null,
          periodStartAt: "2025-01-31 10:00:00",
          periodEndAt: "2025-02-28 10:00:00",
          createdAt: "2025-01-31 10:00:00",
        },
        {
          id: 11,
          userId: 1,
          email: "drift@example.com",
          planType: "monthly",
          accountType: "personal",
          status: "paid",
          paymentMethod: "CREDIT_CARD",
          autoRenew: 1,
          recurringToken: "acid-1",
          subscriptionId: "SUB_DRIFT",
          sourceOrderId: 10,
          periodStartAt: "2025-02-28 10:00:00",
          periodEndAt: "2025-03-28 10:00:00",
          createdAt: "2025-02-28 10:00:00",
        },
        {
          id: 20,
          userId: 2,
          email: "shift@example.com",
          planType: "monthly",
          accountType: "personal",
          status: "paid",
          paymentMethod: "CREDIT_CARD",
          autoRenew: 0,
          recurringToken: "acid-2",
          subscriptionId: "SUB_SHIFT",
          periodStartAt: "2025-04-10 09:00:00",
          periodEndAt: "2025-05-10 18:00:00",
          createdAt: "2025-04-10 09:00:00",
        },
        {
          id: 30,
          userId: 3,
          email: "token@example.com",
          planType: "monthly",
          accountType: "personal",
          status: "paid",
          paymentMethod: "CREDIT_CARD",
          autoRenew: 1,
          recurringToken: null,
          subscriptionId: "SUB_TOKEN",
          periodStartAt: "2026-05-01 00:00:00",
          periodEndAt: "2026-06-01 00:00:00",
          createdAt: "2026-05-01 00:00:00",
        },
        {
          id: 40,
          userId: 4,
          email: "plan@example.com",
          planType: "yearly",
          accountType: "personal",
          status: "paid",
          paymentMethod: "BANK_TRANSFER",
          autoRenew: 0,
          recurringToken: null,
          subscriptionId: "SUB_PLAN",
          periodStartAt: "2026-01-01 00:00:00",
          periodEndAt: "2027-01-01 00:00:00",
          createdAt: "2026-01-01 00:00:00",
        },
      ],
    });

    const drift = findings.find((row) => row.orderId === 11);
    assert.equal(drift.reason, "month_end_drift");
    assert.equal(drift.emailMasked, "d***@example.com");
    assert.equal(drift.expectedPeriodEndAt, "2025-03-31 10:00:00");
    assert.equal(drift.periodEndAt, "2025-03-28 10:00:00");
    assert.match(drift.difference, /end -3d/);
    assert.equal(findings.some((row) => row.orderId === 10), false);

    const shift = findings.find((row) => row.orderId === 20);
    assert.equal(shift.reason, "timezone_shift_9h");
    assert.equal(shift.difference, "end +9h");

    const token = findings.find((row) => row.reason === "paid_card_autorenew_missing_acid");
    assert.equal(token.orderId, 30);
    assert.equal(token.emailMasked, "t***@example.com");

    const plan = findings.find((row) => String(row.reason).startsWith("subscription_plan_mismatch"));
    assert.equal(plan.userId, 4);
    assert.match(plan.reason, /stored=none expected=personal_yearly/);

    const csv = findingsToCsv(findings);
    assert.match(csv, /^userId,emailMasked,orderId,/);
    assert.equal(csv.includes("drift@example.com"), false);
    assert.match(csv, /month_end_drift/);
  });

  it("the audit script source has no write statements", () => {
    const source = fs.readFileSync(new URL("../scripts/audit_subscription_periods.js", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|REPLACE)\b/i);
  });
});
