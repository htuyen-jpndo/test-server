import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";
import { PAYMENT_METHOD } from "../utils/paymentEnums.js";

export const PaymentOrder = sequelize.define(
  "PaymentOrder",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    cod: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    paymentMethod: {
      type: DataTypes.ENUM(
        PAYMENT_METHOD.CREDIT_CARD,
        PAYMENT_METHOD.BANK_TRANSFER,
        PAYMENT_METHOD.FREE
      ),
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
    iid: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    /** Optional J-Payment 課金開始日 anchor (normalized YYYY-MM-DD in DB); sent as `ac4` YYYY/MM/DD on link form. */
    ac4: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    periodStartAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    periodEndAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expectedAmount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    autoRenew: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    recurringToken: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    renewRetryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    renewNextRetryAt: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    renewLastAttemptAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    renewFailureCode: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    stopRequested: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    stopRequestedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    subscriptionId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    sourceOrderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    renewalForPeriodEndAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    uidToken: {
      type: DataTypes.STRING(64),
      allowNull: true,
      unique: true,
    },
    resultToken: {
      type: DataTypes.STRING(64),
      allowNull: true,
      unique: true,
    },
    resultTokenExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    gid: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    god: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    rst: {
      type: DataTypes.STRING(4),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("pending", "paid", "failed", "cancelled", "expired"),
      allowNull: false,
      defaultValue: "pending",
    },
    ec: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    ap: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    am: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    tx: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    sf: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    ta: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    rawParams: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
    },
    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "payment_orders",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      {
        unique: true,
        fields: ["subscriptionId", "renewalForPeriodEndAt"],
        name: "uq_payment_orders_renewal_subscription_period",
      },
    ],
  }
);

