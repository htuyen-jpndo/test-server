/**
 * Read-only audit of stored subscription periods.
 *
 *   npm run audit:subscription-periods
 *   npm run audit:subscription-periods -- --csv /tmp/subscription-audit.csv
 *
 * Uses DB_* / DATABASE_URL. SELECT only: the session transaction is read-only
 * and any other statement is rejected before it is sent.
 */
import fs from "node:fs";
import { sequelize } from "../src/config/db.js";
import {
  assertReadOnlySql,
  auditSubscriptionRows,
  findingsToCsv,
  findingsToTable,
} from "../src/utils/subscriptionPeriodAudit.js";

const ORDER_SQL = `
SELECT
  o.id, o.userId, o.planType, o.accountType, o.status, o.paymentMethod,
  o.autoRenew, o.recurringToken, o.subscriptionId, o.sourceOrderId,
  o.periodStartAt, o.periodEndAt, o.ac4, o.createdAt,
  u.email, u.subscriptionPlan
FROM payment_orders o
LEFT JOIN Users u ON u.id = o.userId
`;

const USER_SQL = `SELECT id, email, subscriptionPlan FROM Users`;

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || "";
}

async function main() {
  const csvPath = argValue("--csv");
  const format = argValue("--format") || "table";

  const runQuery = sequelize.query.bind(sequelize);
  sequelize.query = async (sql, options) => {
    const text = typeof sql === "string" ? sql : sql?.query || "";
    assertReadOnlySql(text);
    return runQuery(sql, options);
  };

  try {
    await sequelize.authenticate();
    await sequelize.query("SET SESSION TRANSACTION READ ONLY");
    await sequelize.query("START TRANSACTION READ ONLY");
    const [orders] = await sequelize.query(ORDER_SQL);
    const [users] = await sequelize.query(USER_SQL);
    const findings = auditSubscriptionRows({ orders, users, now: new Date() });
    const csv = findingsToCsv(findings);
    if (csvPath) fs.writeFileSync(csvPath, csv);
    if (format === "csv") process.stdout.write(csv);
    else process.stdout.write(findingsToTable(findings));
    if (csvPath && format !== "csv") console.log(`wrote ${findings.length} row(s) to ${csvPath}`);
    await sequelize.query("ROLLBACK");
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
