import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

export const Pilot = sequelize.define(
  "Pilot",
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
    },
    fullName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    birthDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    organization: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    emergencyContact: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    certificateType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    limitation: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    certificateNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    issuedDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    expiredDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    totalFlightHours: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    medicalCheckDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  },
  {
    tableName: "pilots",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      { fields: ["userId"] },
      { fields: ["fullName"] },
    ],
  }
);
