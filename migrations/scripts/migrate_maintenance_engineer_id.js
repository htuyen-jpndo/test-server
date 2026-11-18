/**
 * Migration: thêm engineerId (FK → pilots), xóa cột engineer (string) — chỉ dùng engineerId.
 * Chạy SAU migrate_pilot_table.js (cần bảng pilots tồn tại trước).
 */
import { sequelize } from "../src/config/db.js";

async function run() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected");

    const [cols] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'maintenance_records'`
    );
    const columnNames = (cols || []).map((r) => r.COLUMN_NAME);

    if (!columnNames.includes("engineerId")) {
      await sequelize.query(
        `ALTER TABLE maintenance_records ADD COLUMN engineerId CHAR(36) NULL DEFAULT NULL AFTER drone`
      );
      await sequelize.query(
        `ALTER TABLE maintenance_records ADD INDEX idx_maintenance_engineerId (engineerId)`
      );
      console.log("✅ Added column maintenance_records.engineerId");
    } else {
      console.log("Column maintenance_records.engineerId already exists");
    }

    if (columnNames.includes("engineer")) {
      await sequelize.query(`ALTER TABLE maintenance_records DROP COLUMN engineer`);
      console.log("✅ Dropped column maintenance_records.engineer");
    } else {
      console.log("Column maintenance_records.engineer already removed or never existed");
    }

    console.log("✅ Migration maintenance engineerId done.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

run();
