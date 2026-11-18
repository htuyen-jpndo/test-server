import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Maintenance = sequelize.define(
  "Maintenance",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "Users",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    droneId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "drones", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    regId: DataTypes.STRING,
    drone: DataTypes.STRING,
    engineer: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    date: DataTypes.DATEONLY,
    place: DataTypes.STRING,
    total: DataTypes.STRING,
    reason: DataTypes.STRING,
    remarks: DataTypes.TEXT,
    detail: DataTypes.TEXT,
  },
  {
    tableName: "maintenance_records",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      { fields: ["droneId"] },
    ],
  }
);

export default Maintenance;
