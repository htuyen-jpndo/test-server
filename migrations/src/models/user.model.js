import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";
import { USER_STATUS } from "../utils/userStatus.js";

export const User = sequelize.define("User", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: { isEmail: true },
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  resetCode: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  resetExpire: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  role: {
    type: DataTypes.ENUM("admin", "user"),
    defaultValue: "user",
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM(USER_STATUS.ACTIVE, USER_STATUS.SUSPENDED),
    defaultValue: USER_STATUS.ACTIVE,
    allowNull: false,
  },
  subscriptionPlan: {
    type: DataTypes.ENUM(
      "none",
      "personal_monthly",
      "personal_yearly",
      "personal_trial",
      "company_monthly",
      "company_yearly"
    ),
    allowNull: false,
    defaultValue: "none",
  },
}, {
  tableName: "Users",
  timestamps: true,
  initialAutoIncrement: 1,
});
