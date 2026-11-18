import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJstDateTime } from "../src/utils/jstDate.js";
import {
  buildFirstPeriod,
  buildNextPeriodFromPeriodEnd,
  jpaymentAc1Code,
} from "../src/utils/subscriptionRenewalPeriod.js";

function jstStamp(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
}

function chain(planType, anchorRaw, steps) {
  const anchor = parseJstDateTime(anchorRaw);
  const ends = [];
  let cursor = buildFirstPeriod(planType, anchor).end;
  ends.push(jstStamp(cursor));
  for (let i = 1; i < steps; i += 1) {
    cursor = buildNextPeriodFromPeriodEnd(planType, cursor, anchor).end;
    ends.push(jstStamp(cursor));
  }
  return ends;
}

describe("billing period anchor", () => {
  it("keeps day 31 across short months instead of drifting from Feb 28", () => {
    assert.deepEqual(chain("monthly", "2025-01-31 10:15:00", 4), [
      "2025-02-28 10:15:00",
      "2025-03-31 10:15:00",
      "2025-04-30 10:15:00",
      "2025-05-31 10:15:00",
    ]);
    assert.deepEqual(chain("monthly", "2024-01-31 00:00:00", 2), [
      "2024-02-29 00:00:00",
      "2024-03-31 00:00:00",
    ]);
    assert.deepEqual(chain("monthly", "2025-01-30 08:00:00", 3), [
      "2025-02-28 08:00:00",
      "2025-03-30 08:00:00",
      "2025-04-30 08:00:00",
    ]);
  });

  it("returns Feb 29 on the following leap year and keeps Dec 31 yearly", () => {
    assert.deepEqual(chain("yearly", "2024-02-29 08:00:00", 5), [
      "2025-02-28 08:00:00",
      "2026-02-28 08:00:00",
      "2027-02-28 08:00:00",
      "2028-02-29 08:00:00",
      "2029-02-28 08:00:00",
    ]);
    assert.deepEqual(chain("yearly", "2024-12-31 00:00:00", 3), [
      "2025-12-31 00:00:00",
      "2026-12-31 00:00:00",
      "2027-12-31 00:00:00",
    ]);
  });

  it("drifts when the next period is taken from the clamped end instead of the anchor", () => {
    const anchor = parseJstDateTime("2025-01-31 10:15:00");
    const feb28 = buildFirstPeriod("monthly", anchor).end;
    const drifted = buildNextPeriodFromPeriodEnd("monthly", feb28);
    const anchored = buildNextPeriodFromPeriodEnd("monthly", feb28, anchor);
    assert.equal(jstStamp(drifted.end), "2025-03-28 10:15:00");
    assert.equal(jstStamp(anchored.end), "2025-03-31 10:15:00");
  });
});

describe("J-Payment ac1", () => {
  it("sends the anchor day, 99 for the 31st, and nothing for weekly trial", () => {
    assert.equal(jpaymentAc1Code("2025-01-15 12:00:00", "monthly"), "15");
    assert.equal(jpaymentAc1Code("2025-01-30 12:00:00", "monthly"), "30");
    assert.equal(jpaymentAc1Code("2025-01-31 12:00:00", "monthly"), "99");
    assert.equal(jpaymentAc1Code("2024-12-31 00:00:00", "yearly"), "99");
    assert.equal(jpaymentAc1Code("2024-02-29 08:00:00", "yearly"), "29");
    assert.equal(jpaymentAc1Code("2025-03-31 00:00:00", "trial"), null);
  });
});
