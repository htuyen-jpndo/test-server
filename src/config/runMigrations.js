/**
 * Chạy migration trước sequelize.sync() để tránh lỗi "column does not exist"
 * khi deploy (Render, etc.) — DB có thể chưa có pilotId, pilots table.
 *
 * Khóa chính / FK: INT (AUTO_INCREMENT cho PK, bắt đầu từ 1).
 * Nếu DB cũ đang dùng UUID (CHAR(36)): không tự chuyển được sang INT mà giữ quan hệ;
 * cần backup, tạo schema mới hoặc script migrate dữ liệu riêng.
 */
const INT_PK = "INT NOT NULL AUTO_INCREMENT PRIMARY KEY";
const INT_NOT_NULL = "INT NOT NULL";
const INT_NULL = "INT NULL DEFAULT NULL";

async function getFlightColumnNames(sequelize) {
  const [rows] = await sequelize.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'flights'`
  );
  return (rows || []).map((r) => r.COLUMN_NAME);
}

/** Cột payment_method + backfill đơn cũ có planType → CREDIT_CARD. */
async function migratePaymentOrdersPaymentMethod(sequelize) {
  const [payTables] = await sequelize.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'payment_orders'`
  );
  if (!payTables || payTables.length === 0) return;

  const [payRows] = await sequelize.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payment_orders'`
  );
  const payCols = (payRows || []).map((r) => r.COLUMN_NAME);

  try {
    if (!payCols.includes("paymentMethod")) {
      await sequelize.query(`
        ALTER TABLE payment_orders
        ADD COLUMN paymentMethod ENUM('CREDIT_CARD','BANK_TRANSFER','FREE') NULL
      `);
      console.log("✅ Migration: payment_orders.paymentMethod added");
    }
    await sequelize.query(`
      UPDATE payment_orders
      SET paymentMethod = 'CREDIT_CARD'
      WHERE paymentMethod IS NULL AND planType IS NOT NULL
    `);
  } catch (e) {
    console.warn("⚠️ Migration payment_orders.paymentMethod:", e.message);
  }
}

/** ENUM đầy đủ + FK payment_orders.userId → Users.id (PlanetScale/TiDB có thể bỏ qua FK). */
async function migratePaymentOrdersProduction(sequelize) {
  const [payTables] = await sequelize.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'payment_orders'`
  );
  if (!payTables || payTables.length === 0) return;

  try {
    const [statusCol] = await sequelize.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_orders' AND COLUMN_NAME = 'status'`
    );
    const ct = String(statusCol?.[0]?.COLUMN_TYPE || "");
    if (ct && !ct.includes("expired")) {
      await sequelize.query(`
        ALTER TABLE payment_orders MODIFY COLUMN status
        ENUM('pending','paid','failed','cancelled','expired') NOT NULL DEFAULT 'pending'
      `);
      console.log("✅ Migration: payment_orders.status ENUM extended (cancelled, expired)");
    }
  } catch (e) {
    console.warn("⚠️ Migration payment_orders ENUM:", e.message);
  }

  try {
    const [fks] = await sequelize.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_orders'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'fk_payment_orders_userId'`
    );
    if (fks && fks.length > 0) return;

    await sequelize.query(`
      UPDATE payment_orders po
      LEFT JOIN Users u ON u.id = po.userId
      SET po.userId = NULL
      WHERE po.userId IS NOT NULL AND u.id IS NULL
    `);
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
    try {
      await sequelize.query(`
        ALTER TABLE payment_orders
        ADD CONSTRAINT fk_payment_orders_userId
        FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE SET NULL ON UPDATE CASCADE
      `);
      console.log("✅ Migration: fk_payment_orders_userId (payment_orders.userId → Users.id)");
    } finally {
      await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
    }
  } catch (e) {
    console.warn(
      "⚠️ Could not add FK fk_payment_orders_userId (PlanetScale/TiDB may not support it):",
      e.message
    );
  }
}

/**
 * Code mới dùng PK `id` (INT AI); DB cũ dùng `flightId` (VARCHAR) → SELECT thất bại (500).
 * TiDB (và một số engine) không hỗ trợ: ADD COLUMN id … AUTO_INCREMENT trong một ALTER (errno 8200).
 * Cách tương thích: ADD id INT NULL → đánh số 1..n → NOT NULL → đổi PK → DROP flightId → MODIFY AUTO_INCREMENT.
 */
async function migrateFlightsFlightIdToIntegerId(sequelize, flightColNames) {
  const orderBy = flightColNames.includes("createdAt")
    ? "`createdAt` ASC, `flightId` ASC"
    : "`flightId` ASC";

  await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    await sequelize.query("ALTER TABLE flights ADD COLUMN id INT NULL");

    try {
      await sequelize.query(`
        UPDATE flights AS f
        INNER JOIN (
          SELECT flightId, ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rn
          FROM flights
        ) AS x ON f.flightId = x.flightId
        SET f.id = x.rn
      `);
    } catch (e) {
      console.warn("Migration flights: ROW_NUMBER failed, using session variable:", e.message);
      await sequelize.transaction(async (transaction) => {
        await sequelize.query("SET @flight_rownum := 0", { transaction });
        await sequelize.query(
          `UPDATE flights SET id = (@flight_rownum := @flight_rownum + 1) ORDER BY ${orderBy}`,
          { transaction }
        );
      });
    }

    await sequelize.query("ALTER TABLE flights MODIFY COLUMN id INT NOT NULL");
    await sequelize.query("ALTER TABLE flights DROP PRIMARY KEY");
    await sequelize.query("ALTER TABLE flights ADD PRIMARY KEY (id)");
    await sequelize.query("ALTER TABLE flights DROP COLUMN `flightId`");
    await sequelize.query(
      "ALTER TABLE flights MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT"
    );
    await sequelize.query("ALTER TABLE flights AUTO_INCREMENT = 1");

    console.log("✅ Migration: flights — legacy flightId → id (INT AUTO_INCREMENT, TiDB-safe)");
  } finally {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}

export async function runMigrations(sequelize) {
  let flightCols = await getFlightColumnNames(sequelize);

  if (
    flightCols.length > 0 &&
    flightCols.includes("flightId") &&
    !flightCols.includes("id")
  ) {
    try {
      await migrateFlightsFlightIdToIntegerId(sequelize, flightCols);
      flightCols = await getFlightColumnNames(sequelize);
    } catch (e) {
      console.error("❌ Migration flights flightId→id:", e.message);
      throw e;
    }
  }

  if (flightCols.length > 0) {
    if (!flightCols.includes("pilotId")) {
      await sequelize.query(`ALTER TABLE flights ADD COLUMN pilotId ${INT_NULL}`);
      await sequelize.query(`ALTER TABLE flights ADD INDEX idx_flights_pilotId (pilotId)`);
      console.log("✅ Migration: added flights.pilotId");
    }
    if (flightCols.includes("pilot")) {
      await sequelize.query(`ALTER TABLE flights DROP COLUMN pilot`);
      console.log("✅ Migration: dropped flights.pilot");
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
    console.log("✅ Migration: created table pilots");
  }

  const [droneTables] = await sequelize.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'drones'`
  );
  if (!droneTables || droneTables.length === 0) {
    await sequelize.query(`
      CREATE TABLE drones (
        id ${INT_PK},
        userId ${INT_NOT_NULL},
        droneName VARCHAR(255),
        registrationCode VARCHAR(255),
        manufacturer VARCHAR(255),
        modelType VARCHAR(255),
        serialNumber VARCHAR(255),
        droneWeight DECIMAL(10,2),
        purpose VARCHAR(255),
        registrantName VARCHAR(255),
        registrationExpiry DATE,
        remoteIdInfo TEXT,
        remoteIdModelType VARCHAR(255),
        remoteIdSerialNumber VARCHAR(255),
        dailyInspectionItems TEXT,
        periodicInspectionHistory TEXT,
        insuranceCompany VARCHAR(255),
        coverageAmount DECIMAL(15,2),
        insuranceExpiry DATE,
        createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL,
        INDEX idx_drones_userId (userId),
        INDEX idx_drones_registrationCode (registrationCode),
        INDEX idx_drones_serialNumber (serialNumber)
      ) AUTO_INCREMENT=1
    `);
    console.log("✅ Migration: created table drones");
  }

  if (flightCols.length > 0 && !flightCols.includes("droneId")) {
    await sequelize.query(`ALTER TABLE flights ADD COLUMN droneId ${INT_NULL}`);
    await sequelize.query(`ALTER TABLE flights ADD INDEX idx_flights_droneId (droneId)`);
    console.log("✅ Migration: added flights.droneId");
  }

  const [maintRows] = await sequelize.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'maintenance_records'`
  );
  const maintCols = (maintRows || []).map((r) => r.COLUMN_NAME);

  if (maintCols.length > 0) {
    if (maintCols.includes("flightId")) {
      try {
        const [fkRows] = await sequelize.query(`
          SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'maintenance_records' 
          AND COLUMN_NAME = 'flightId' AND REFERENCED_TABLE_NAME IS NOT NULL
        `);
        if (fkRows && fkRows.length > 0) {
          await sequelize.query(
            `ALTER TABLE maintenance_records DROP FOREIGN KEY \`${fkRows[0].CONSTRAINT_NAME}\``
          );
        }
        await sequelize.query(`ALTER TABLE maintenance_records DROP COLUMN flightId`);
        console.log("✅ Migration: dropped maintenance_records.flightId");
      } catch (e) {
        console.warn("Migration flightId drop:", e.message);
      }
    }
    if (!maintCols.includes("droneId")) {
      await sequelize.query(`ALTER TABLE maintenance_records ADD COLUMN droneId ${INT_NULL}`);
      await sequelize.query(`ALTER TABLE maintenance_records ADD INDEX idx_maintenance_droneId (droneId)`);
      console.log("✅ Migration: added maintenance_records.droneId");
    }
    if (maintCols.includes("engineerId")) {
      try {
        const [fkRows] = await sequelize.query(`
          SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'maintenance_records' 
          AND COLUMN_NAME = 'engineerId' AND REFERENCED_TABLE_NAME = 'pilots'
        `);
        if (fkRows && fkRows.length > 0) {
          await sequelize.query(
            `ALTER TABLE maintenance_records DROP FOREIGN KEY \`${fkRows[0].CONSTRAINT_NAME}\``
          );
        }
        await sequelize.query(`ALTER TABLE maintenance_records DROP COLUMN engineerId`);
        console.log("✅ Migration: dropped maintenance_records.engineerId");
      } catch (e) {
        console.warn("Migration engineerId drop:", e.message);
      }
    }
    if (!maintCols.includes("engineer")) {
      await sequelize.query(
        `ALTER TABLE maintenance_records ADD COLUMN engineer VARCHAR(255) NULL DEFAULT NULL`
      );
      console.log("✅ Migration: added maintenance_records.engineer");
    }
  }

  const [userOptTables] = await sequelize.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'user_options'`
  );
  if (userOptTables && userOptTables.length > 0) {
    try {
      const [enumCol] = await sequelize.query(`
        SELECT COLUMN_TYPE FROM information_schema.COLUMNS 
        WHERE table_schema = DATABASE() AND table_name = 'user_options' AND COLUMN_NAME = 'type'
      `);
      const currentEnum = enumCol?.[0]?.COLUMN_TYPE || "";
      if (currentEnum && !currentEnum.includes("maintenance-detail")) {
        await sequelize.query(`
          UPDATE user_options SET type = 'maintenance-detail' WHERE type = 'maintenance-checklist-item'
        `);
        await sequelize.query(`
          ALTER TABLE user_options MODIFY COLUMN type ENUM('pilot', 'drone', 'purpose', 'maintenance-detail') NOT NULL
        `);
        console.log("✅ Migration: user_options type ENUM updated to include maintenance-detail");
      }
    } catch (e) {
      console.warn("Migration user_options ENUM:", e.message);
    }
  }

  const [userRows] = await sequelize.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'Users'`
  );
  const userCols = (userRows || []).map((r) => r.COLUMN_NAME);
  if (!userCols.includes("status")) {
    await sequelize.query(`
      ALTER TABLE Users
      ADD COLUMN status ENUM('active', 'suspended') NOT NULL DEFAULT 'active'
    `);
    console.log("✅ Migration: added Users.status");
  } else {
    await sequelize.query(`
      UPDATE Users
      SET status = 'active'
      WHERE status IS NULL OR status = ''
    `);
    await sequelize.query(`
      ALTER TABLE Users
      MODIFY COLUMN status ENUM('active', 'suspended') NOT NULL DEFAULT 'active'
    `);
    console.log("✅ Migration: normalized Users.status enum values");
  }

  if (!userCols.includes("subscriptionPlan")) {
    await sequelize.query(`
      ALTER TABLE Users
      ADD COLUMN subscriptionPlan ENUM(
        'none',
        'personal_monthly',
        'personal_yearly',
        'personal_trial',
        'company_monthly',
        'company_yearly'
      ) NOT NULL DEFAULT 'none'
    `);
    console.log("✅ Migration: added Users.subscriptionPlan");
  } else {
    // Chuẩn hóa dữ liệu legacy trước khi đổi ENUM.
    await sequelize.query(`
      UPDATE Users
      SET subscriptionPlan = 'none'
      WHERE subscriptionPlan IS NULL OR subscriptionPlan IN ('monthly', 'yearly', '', 'company_trial')
    `);
    await sequelize.query(`
      ALTER TABLE Users
      MODIFY COLUMN subscriptionPlan ENUM(
        'none',
        'personal_monthly',
        'personal_yearly',
        'personal_trial',
        'company_monthly',
        'company_yearly'
      ) NOT NULL DEFAULT 'none'
    `);
    console.log("✅ Migration: normalized Users.subscriptionPlan enum values");
  }

  const [payTables] = await sequelize.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'payment_orders'`
  );
  if (!payTables || payTables.length === 0) {
    await sequelize.query(`
      CREATE TABLE payment_orders (
        id ${INT_PK},
        cod VARCHAR(64) NOT NULL UNIQUE,
        userId INT NULL,
        paymentMethod ENUM('CREDIT_CARD','BANK_TRANSFER','FREE') NULL,
        planType ENUM('monthly','yearly','trial') NULL,
        accountType ENUM('personal','company') NULL,
        iid VARCHAR(50) NULL,
        ac4 VARCHAR(10) NULL,
        periodStartAt DATETIME NULL,
        periodEndAt DATETIME NULL,
        expectedAmount INT NULL,
        autoRenew TINYINT(1) NOT NULL DEFAULT 1,
        recurringToken VARCHAR(255) NULL,
        renewRetryCount INT NOT NULL DEFAULT 0,
        renewNextRetryAt DATE NULL,
        renewLastAttemptAt DATETIME NULL,
        renewFailureCode VARCHAR(64) NULL,
        stopRequested TINYINT(1) NOT NULL DEFAULT 0,
        stopRequestedAt DATETIME NULL,
        cancelledAt DATETIME NULL,
        subscriptionId VARCHAR(64) NULL,
        sourceOrderId INT NULL,
        renewalForPeriodEndAt DATETIME NULL,
        uidToken VARCHAR(64) NULL UNIQUE,
        resultToken VARCHAR(64) NULL UNIQUE,
        resultTokenExpiresAt DATETIME NULL,
        gid VARCHAR(32),
        god VARCHAR(32),
        rst VARCHAR(4),
        status ENUM('pending','paid','failed','cancelled','expired') NOT NULL DEFAULT 'pending',
        ec VARCHAR(32),
        ap VARCHAR(16),
        am INT,
        tx INT,
        sf INT,
        ta INT,
        rawParams LONGTEXT,
        paidAt DATETIME NULL,
        createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL,
        INDEX idx_payment_orders_userId (userId),
        INDEX idx_payment_orders_gid (gid),
        INDEX idx_payment_orders_status (status),
        UNIQUE INDEX uq_payment_orders_renewal_subscription_period (subscriptionId, renewalForPeriodEndAt)
      ) AUTO_INCREMENT=1
    `);
    console.log("✅ Migration: created table payment_orders");
  } else {
    const [payRows] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payment_orders'`
    );
    const payCols = (payRows || []).map((r) => r.COLUMN_NAME);

    if (!payCols.includes("userId")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN userId INT NULL`);
      await sequelize.query(`ALTER TABLE payment_orders ADD INDEX idx_payment_orders_userId (userId)`);
    }
    if (!payCols.includes("paymentMethod")) {
      await sequelize.query(
        `ALTER TABLE payment_orders ADD COLUMN paymentMethod ENUM('CREDIT_CARD','BANK_TRANSFER','FREE') NULL`
      );
    }
    if (!payCols.includes("planType")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN planType ENUM('monthly','yearly','trial') NULL`);
    }
    await sequelize.query(`
      ALTER TABLE payment_orders
      MODIFY COLUMN planType ENUM('monthly','yearly','trial') NULL
    `);
    if (!payCols.includes("accountType")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN accountType ENUM('personal','company') NULL`);
    }
    if (!payCols.includes("iid")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN iid VARCHAR(50) NULL`);
    }
    if (!payCols.includes("periodStartAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN periodStartAt DATETIME NULL`);
    }
    if (!payCols.includes("periodEndAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN periodEndAt DATETIME NULL`);
    }
    if (!payCols.includes("expectedAmount")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN expectedAmount INT NULL`);
    }
    if (!payCols.includes("autoRenew")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN autoRenew TINYINT(1) NOT NULL DEFAULT 1`);
    }
    if (!payCols.includes("recurringToken")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN recurringToken VARCHAR(255) NULL`);
    }
    if (!payCols.includes("uidToken")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN uidToken VARCHAR(64) NULL`);
      await sequelize.query(`ALTER TABLE payment_orders ADD UNIQUE INDEX uq_payment_orders_uidToken (uidToken)`);
    }
    if (!payCols.includes("resultToken")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN resultToken VARCHAR(64) NULL`);
      await sequelize.query(`ALTER TABLE payment_orders ADD UNIQUE INDEX uq_payment_orders_resultToken (resultToken)`);
    }
    if (!payCols.includes("resultTokenExpiresAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN resultTokenExpiresAt DATETIME NULL`);
    }
    if (!payCols.includes("god")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN god VARCHAR(32) NULL`);
    }
    if (!payCols.includes("paidAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN paidAt DATETIME NULL`);
    }
    if (!payCols.includes("renewRetryCount")) {
      await sequelize.query(
        `ALTER TABLE payment_orders ADD COLUMN renewRetryCount INT NOT NULL DEFAULT 0`
      );
    }
    if (!payCols.includes("renewNextRetryAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN renewNextRetryAt DATE NULL`);
    }
    if (!payCols.includes("renewLastAttemptAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN renewLastAttemptAt DATETIME NULL`);
    }
    if (!payCols.includes("renewFailureCode")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN renewFailureCode VARCHAR(64) NULL`);
    }
    if (!payCols.includes("stopRequested")) {
      await sequelize.query(
        `ALTER TABLE payment_orders ADD COLUMN stopRequested TINYINT(1) NOT NULL DEFAULT 0`
      );
    }
    if (!payCols.includes("stopRequestedAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN stopRequestedAt DATETIME NULL`);
    }
    if (!payCols.includes("cancelledAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN cancelledAt DATETIME NULL`);
    }
    if (!payCols.includes("sourceOrderId")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN sourceOrderId INT NULL`);
    }
    if (!payCols.includes("subscriptionId")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN subscriptionId VARCHAR(64) NULL`);
    }
    if (!payCols.includes("renewalForPeriodEndAt")) {
      await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN renewalForPeriodEndAt DATETIME NULL`);
    }

    const [periodStartType] = await sequelize.query(`
      SELECT DATA_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'payment_orders'
        AND COLUMN_NAME = 'periodStartAt'
      LIMIT 1
    `);
    if (String(periodStartType?.[0]?.DATA_TYPE || "").toLowerCase() === "date") {
      await sequelize.query(`
        ALTER TABLE payment_orders
        MODIFY COLUMN periodStartAt DATETIME NULL
      `);
    }

    const [periodEndType] = await sequelize.query(`
      SELECT DATA_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'payment_orders'
        AND COLUMN_NAME = 'periodEndAt'
      LIMIT 1
    `);
    if (String(periodEndType?.[0]?.DATA_TYPE || "").toLowerCase() === "date") {
      await sequelize.query(`
        ALTER TABLE payment_orders
        MODIFY COLUMN periodEndAt DATETIME NULL
      `);
      await sequelize.query(`
        UPDATE payment_orders
        SET periodEndAt = DATE_ADD(periodEndAt, INTERVAL 86399 SECOND)
        WHERE periodEndAt IS NOT NULL
      `);
    }

    const [renewalForPeriodEndAtType] = await sequelize.query(`
      SELECT DATA_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'payment_orders'
        AND COLUMN_NAME = 'renewalForPeriodEndAt'
      LIMIT 1
    `);
    if (String(renewalForPeriodEndAtType?.[0]?.DATA_TYPE || "").toLowerCase() === "date") {
      await sequelize.query(`
        ALTER TABLE payment_orders
        MODIFY COLUMN renewalForPeriodEndAt DATETIME NULL
      `);
      await sequelize.query(`
        UPDATE payment_orders
        SET renewalForPeriodEndAt = DATE_ADD(renewalForPeriodEndAt, INTERVAL 86399 SECOND)
        WHERE renewalForPeriodEndAt IS NOT NULL
      `);
    }

    const [oldRenewalUniqueIdx] = await sequelize.query(`
      SELECT INDEX_NAME
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'payment_orders'
        AND index_name = 'uq_payment_orders_renewal_source_period'
      LIMIT 1
    `);
    if (oldRenewalUniqueIdx && oldRenewalUniqueIdx.length > 0) {
      await sequelize.query(`
        DROP INDEX uq_payment_orders_renewal_source_period ON payment_orders
      `);
    }

    const [renewalUniqueIdx] = await sequelize.query(`
      SELECT INDEX_NAME
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'payment_orders'
        AND index_name = 'uq_payment_orders_renewal_subscription_period'
      LIMIT 1
    `);
    if (!renewalUniqueIdx || renewalUniqueIdx.length === 0) {
      await sequelize.query(`
        CREATE UNIQUE INDEX uq_payment_orders_renewal_subscription_period
        ON payment_orders (subscriptionId, renewalForPeriodEndAt)
      `);
    }

    try {
      const [ac4Cols] = await sequelize.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'payment_orders' AND column_name = 'ac4'
      `);
      if (!ac4Cols || ac4Cols.length === 0) {
        await sequelize.query(`ALTER TABLE payment_orders ADD COLUMN ac4 VARCHAR(10) NULL`);
        console.log("✅ Migration: payment_orders.ac4 added");
      }
    } catch (e) {
      console.warn("⚠️ Migration payment_orders.ac4:", e.message);
    }
  }

  await migratePaymentOrdersPaymentMethod(sequelize);
  await migratePaymentOrdersProduction(sequelize);
  await migrateUserPaymentCancellations(sequelize);
}

/** Lịch sử user hủy / bỏ dở thanh toán (checkout) — tạo bảng nếu chưa có; tùy chọn thêm FK. */
async function migrateUserPaymentCancellations(sequelize) {
  const [tables] = await sequelize.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'user_payment_cancellations'`
  );
  if (!tables || tables.length === 0) {
    try {
      await sequelize.query(`
        CREATE TABLE user_payment_cancellations (
          id ${INT_PK},
          userId ${INT_NOT_NULL},
          paymentOrderId ${INT_NULL},
          cod VARCHAR(64) NULL,
          planType ENUM('monthly','yearly','trial') NULL,
          accountType ENUM('personal','company') NULL,
          source VARCHAR(64) NULL,
          note TEXT NULL,
          clientMeta LONGTEXT NULL,
          createdAt DATETIME NOT NULL,
          updatedAt DATETIME NOT NULL,
          INDEX idx_user_payment_cancellations_userId (userId),
          INDEX idx_user_payment_cancellations_paymentOrderId (paymentOrderId)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log("✅ Migration: created table user_payment_cancellations");
    } catch (e) {
      console.warn("⚠️ Migration user_payment_cancellations create:", e.message);
    }
  }

  try {
    const [fks] = await sequelize.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_payment_cancellations'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'fk_user_payment_cancellations_userId'`
    );
    if (fks && fks.length > 0) return;

    const [t2] = await sequelize.query(
      `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'user_payment_cancellations'`
    );
    if (!t2 || t2.length === 0) return;

    await sequelize.query(`
      DELETE u FROM user_payment_cancellations u
      LEFT JOIN Users usr ON usr.id = u.userId
      WHERE usr.id IS NULL
    `);
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
    try {
      await sequelize.query(`
        ALTER TABLE user_payment_cancellations
        ADD CONSTRAINT fk_user_payment_cancellations_userId
        FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE ON UPDATE CASCADE
      `);
      console.log("✅ Migration: fk user_payment_cancellations.userId → Users.id");
    } finally {
      await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
    }
  } catch (e) {
    console.warn(
      "⚠️ Could not add FK fk_user_payment_cancellations_userId (some hosts disallow FK):",
      e.message
    );
  }
}
