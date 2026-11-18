/**
 * Backfill Users.subscriptionPlan từ payment_orders.
 *
 * Rule:
 * - Lấy đơn paid mới nhất.
 * - Nếu còn hạn: set personal/company + monthly/yearly.
 * - Nếu hết hạn hoặc không có đơn hợp lệ: set "none".
 *
 * Chạy:
 *   npm run migrate:sync-subscription-plan
 */
import { sequelize } from "../src/config/db.js";
import { runMigrations } from "../src/config/runMigrations.js";
import { User } from "../src/models/user.model.js";
import { refreshAndSyncUserSubscriptionState } from "../src/middlewares/subscription.middleware.js";

async function main() {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to DB");

    // Ensure schema/migration is up-to-date before backfill.
    await runMigrations(sequelize);
    await sequelize.sync();

    const users = await User.findAll({
      attributes: ["id", "email", "subscriptionPlan"],
      order: [["id", "ASC"]],
    });

    let updated = 0;
    for (const user of users) {
      const before = user.subscriptionPlan || "none";
      const snapshot = await refreshAndSyncUserSubscriptionState(user.id);
      const after =
        snapshot?.status === "active" &&
        (snapshot?.accountType === "personal" || snapshot?.accountType === "company") &&
        (snapshot?.planType === "monthly" || snapshot?.planType === "yearly")
          ? `${snapshot.accountType}_${snapshot.planType}`
          : "none";
      if (before !== after) updated += 1;
      console.log(
        `[SYNC] userId=${user.id} email=${user.email || "-"} ${before} -> ${after}`
      );
    }

    console.log(
      `\n✅ Done. totalUsers=${users.length}, updated=${updated}, unchanged=${users.length - updated}`
    );
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error("❌ sync_user_subscription_plan:", err);
    try {
      await sequelize.close();
    } catch {}
    process.exit(1);
  }
}

main();
