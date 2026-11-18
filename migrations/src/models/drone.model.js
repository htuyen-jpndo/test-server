import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

export const Drone = sequelize.define(
  "Drone",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "Users", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    // 機体名称 - Drone name
    droneName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 登録記号 - Registration code
    registrationCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // メーカー - Manufacturer
    manufacturer: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 型式 - Model type
    modelType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 製造番号 - Serial number
    serialNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 機体重量 - Drone weight (kg)
    droneWeight: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    // 用途 - Purpose/Use
    purpose: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 登録者名 - Registrant name
    registrantName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 登録有効期限 - Registration validity period
    registrationExpiry: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // リモートID情報 - Remote ID information
    remoteIdInfo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // リモートID 型式 - Remote ID model type
    remoteIdModelType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // リモートID 製造番号 - Remote ID serial number
    remoteIdSerialNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 日常点検項目 - Daily inspection items
    dailyInspectionItems: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // 定期点検履歴 - Periodic inspection history
    periodicInspectionHistory: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // 保険会社名 - Insurance company name
    insuranceCompany: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // 補償額 - Coverage amount
    coverageAmount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
    },
    // 保険有効期限 - Insurance validity period
    insuranceExpiry: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  },
  {
    tableName: "drones",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      { fields: ["userId"] },
      { fields: ["registrationCode"] },
      { fields: ["serialNumber"] },
    ],
  }
);
