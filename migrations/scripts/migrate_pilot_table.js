/**
 * Migration: tách pilot ra bảng pilots, flight.pilot (string) → flight.pilotId (FK).
 * - Thêm cột pilotId vào flights, xóa pilot (string)
 * - Tạo bảng pilots nếu chưa có
 * Chạy TRƯỚC migrate_maintenance_engineer_id.js (vì maintenance.engineerId FK → pilots).
 *
 * Khóa: INT AUTO_INCREMENT / INT (khớp Sequelize models hiện tại).
 */
const INT_PK = "INT NOT NULL AUTO_INCREMENT PRIMARY KEY";
const INT_NOT_NULL = "INT NOT NULL";
const INT_NULL = "INT NULL DEFAULT NULL";

import { sequelize } from "../src/config/db.js";

async function run() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected");

    const [cols] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'flights'`
    );
    const columnNames = (cols || []).map((r) => r.COLUMN_NAME);

    if (columnNames.length === 0) {
      console.log("Table flights chưa tồn tại — bỏ qua migration flights.");
    } else {
      if (!columnNames.includes("pilotId")) {
        await sequelize.query(
          `ALTER TABLE flights ADD COLUMN pilotId ${INT_NULL}`
        );
        await sequelize.query(
          `ALTER TABLE flights ADD INDEX idx_flights_pilotId (pilotId)`
        );
        console.log("✅ Added column flights.pilotId");
      }
      if (columnNames.includes("pilot")) {
        await sequelize.query(`ALTER TABLE flights DROP COLUMN pilot`);
        console.log("✅ Dropped column flights.pilot");
      }
    }

    const [tables] = await sequelize.query(
      `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'pilots'`
    );
    if (!tables || tables.length === 0) {
      await sequelize.query(`
        CREATE TABLE pilots (
          id ${INT_PK},
          userId ${INT_NOT_NULL},
          fullName VARCHAR(255) NOT NULL,
          birthDate DATE,
          organization VARCHAR(255),
          phone VARCHAR(255),
          email VARCHAR(255),
          emergencyContact VARCHAR(255),
          certificateType VARCHAR(255),
          limitation VARCHAR(255),
          certificateNumber VARCHAR(255),
          issuedDate DATE,
          expiredDate DATE,
          totalFlightHours DECIMAL(10,2),
          medicalCheckDate DATE,
          createdAt DATETIME NOT NULL,
          updatedAt DATETIME NOT NULL,
          INDEX idx_pilots_userId (userId),
          INDEX idx_pilots_fullName (fullName)
        ) AUTO_INCREMENT=1
      `);
      console.log("✅ Created table pilots");
    }

    console.log("✅ Migration pilot table done.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

run();
