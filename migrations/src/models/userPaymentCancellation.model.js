import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

export const UserPaymentCancellation = sequelize.define(
  "UserPaymentCancellation",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    paymentOrderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    cod: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    planType: {
      type: DataTypes.ENUM("monthly", "yearly", "trial"),
      allowNull: true,
    },
    accountType: {
      type: DataTypes.ENUM("personal", "company"),
      allowNull: true,
    },
    source: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    clientMeta: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
    },
  },
  {
    tableName: "user_payment_cancellations",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      { fields: ["userId"], name: "idx_user_payment_cancellations_userId" },
      { fields: ["paymentOrderId"], name: "idx_user_payment_cancellations_paymentOrderId" },
    ],
  }
);
