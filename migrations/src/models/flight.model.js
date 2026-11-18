import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

export const Flight = sequelize.define(
  "Flight",
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
    pilotId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "pilots", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    droneId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "drones", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    drone: DataTypes.STRING,
    purpose: DataTypes.STRING,
    location: DataTypes.STRING,
    takeoffTime: DataTypes.DATE,
    landTime: DataTypes.DATE,
    duration: {
      type: DataTypes.STRING(8),
      allowNull: false,
      validate: {
        is: /^\d{2}:\d{2}:\d{2}$/
      }
    },
    preFlightChecks: DataTypes.JSON,
    postFlightChecks: DataTypes.JSON,
    checklistRemarks: DataTypes.JSON,  // Array of objects: [{ item: String, remarks: String }]
    checklistNotes: DataTypes.TEXT,    // Notes for checklist
    postLanding: DataTypes.JSON,
    flightSquawk: DataTypes.STRING,
    actionDate: DataTypes.DATEONLY,
    correctiveAction: DataTypes.TEXT,
  },
  {
    tableName: "flights",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      { fields: ["userId"] },
      { fields: ["pilotId"] },
      { fields: ["droneId"] },
    ]
  }
);
