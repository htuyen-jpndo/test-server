/**
 * Xóa toàn bộ dữ liệu trong các bảng của app (giữ nguyên cấu trúc bảng).
 * TRUNCATE reset AUTO_INCREMENT về 1 (MySQL/TiDB).
 *
 * Chạy (bắt buộc xác nhận):
 *   ALLOW_DB_WIPE=1 node scripts/wipe_database.js
 *   node scripts/wipe_database.js --yes
 *
 * Windows PowerShell:
 *   $env:ALLOW_DB_WIPE="1"; node scripts/wipe_database.js
 */
import dotenv from "dotenv";
import { sequelize } from "../src/config/db.js";

dotenv.config();

/** Thứ tự: con trước cha (an toàn nếu FK bật); với FK_CHECKS=0 thứ tự không bắt buộc. */
const TABLES = [
  "flights",
  "maintenance_records",
  "pilots",
  "drones",
  "user_options",
  "Contacts",
  "Users",
];

async function main() {
  const allowed =
    process.env.ALLOW_DB_WIPE === "1" ||
    process.argv.includes("--yes");
  if (!allowed) {
    console.error(
      "Từ chối: xóa DB cần xác nhận. Chạy với ALLOW_DB_WIPE=1 hoặc thêm --yes"
    );
    process.exit(1);
  }

  await sequelize.authenticate();
  console.log("✅ Đã kết nối DB\n");

  await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const name of TABLES) {
      try {
        await sequelize.query(`TRUNCATE TABLE \`${name}\``);
        console.log("🗑️  TRUNCATE", name);
      } catch (e) {
        const code = e?.original?.code;
        const msg = String(e?.message || e?.original?.sqlMessage || "");
        if (code === "ER_NO_SUCH_TABLE" || msg.includes("doesn't exist")) {
          console.log("⏭️  Bỏ qua (chưa có bảng):", name);
        } else {
          throw e;
        }
      }
    }
  } finally {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
  }

  await sequelize.close();
  console.log("\n✅ Đã xóa hết dữ liệu các bảng. Khởi động lại server để tạo lại admin (nếu có ensureAdminExists).");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ wipe_database:", err);
  process.exit(1);
});
