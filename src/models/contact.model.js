import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

export const Contact = sequelize.define(
  "Contact",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    tel: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    subject: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: "usage | billing | technical | other",
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: "search | sns | introduction | other",
    },
    status: {
      type: DataTypes.ENUM("new", "in_progress", "resolved", "closed"),
      allowNull: false,
      defaultValue: "new",
    },
  },
  {
    tableName: "Contacts",
    timestamps: true,
    initialAutoIncrement: 1,
  }
);
