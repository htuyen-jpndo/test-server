import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

export const UserOption = sequelize.define(
  "UserOption",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
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
    type: {
      type: DataTypes.ENUM(
        "pilot",
        "drone",
        "purpose",
        // "maintenance-checklist-item",
        "maintenance-detail",
      ),
      allowNull: false,
    },
    value: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: "user_options",
    timestamps: true,
    initialAutoIncrement: 1,
    indexes: [
      {
        unique: true,
        fields: ["userId", "type", "value"],
      },
      {
        fields: ["userId", "type"],
      },
    ],
  }
);
