import { Sequelize } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

// 🚀 Sử dụng connection string DATABASE_URL từ TiDB Cloud
// Prefer a full DATABASE_URL (TiDB Cloud), but fall back to DB_* env vars for local dev
const connectionString = process.env.DATABASE_URL || `mysql://${process.env.DB_USER || 'root'}:${process.env.DB_PASS || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'drone_flight'}`;

export const sequelize = new Sequelize(connectionString, {
  dialect: "mysql",
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 60000,
    idle: 10000,
  },
  dialectOptions: {
    // For local MySQL don't require SSL; TiDB Cloud will still work with DATABASE_URL
    ssl: process.env.DATABASE_URL ? { require: true, rejectUnauthorized: true } : undefined,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 15000),
    dateStrings: true,
    typeCast: true,
  },
  timezone: "+09:00",
});

export const connectDB = async () => {
  await sequelize.authenticate();
  const cfg = process.env.DATABASE_URL ? "DATABASE_URL" : `${process.env.DB_HOST || "localhost"}/${process.env.DB_NAME || "drone_flight"}`;
  console.log("✅ DB connected:", cfg);
};
