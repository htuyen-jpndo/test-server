import { sequelize } from "../config/db.js";

// import models
import { User } from "./user.model.js";
import { Flight } from "./flight.model.js";
import { Pilot } from "./pilot.model.js";
import Maintenance from "./maintenance.model.js";
import { UserOption } from "./userOption.model.js";
import { Contact } from "./contact.model.js";
import { Drone } from "./drone.model.js";
import { PaymentOrder } from "./paymentOrder.model.js";
import { UserPaymentCancellation } from "./userPaymentCancellation.model.js";

/* ============================================================
   USER ↔ FLIGHT
============================================================ */

User.hasMany(Flight, {
  foreignKey: "userId",
  onDelete: "CASCADE",
});

Flight.belongsTo(User, {
  foreignKey: "userId",
});

/* ============================================================
   USER ↔ PILOT
============================================================ */

User.hasMany(Pilot, {
  foreignKey: "userId",
  onDelete: "CASCADE",
});

Pilot.belongsTo(User, {
  foreignKey: "userId",
});

/* ============================================================
   PILOT ↔ FLIGHT
============================================================ */

Pilot.hasMany(Flight, {
  foreignKey: "pilotId",
  onDelete: "SET NULL",
});

Flight.belongsTo(Pilot, {
  foreignKey: "pilotId",
});

/* ============================================================
   USER ↔ USER OPTION (pilot / drone / purpose)
============================================================ */

User.hasMany(UserOption, {
  foreignKey: "userId",
  onDelete: "CASCADE",
});

UserOption.belongsTo(User, {
  foreignKey: "userId",
});

/* ============================================================
   USER ↔ MAINTENANCE
============================================================ */

User.hasMany(Maintenance, {
  foreignKey: "userId",
  onDelete: "CASCADE",
});

Maintenance.belongsTo(User, {
  foreignKey: "userId",
});

/* ============================================================
   USER ↔ DRONE
============================================================ */

User.hasMany(Drone, {
  foreignKey: "userId",
  onDelete: "CASCADE",
});

Drone.belongsTo(User, {
  foreignKey: "userId",
});

/* ============================================================
   DRONE ↔ FLIGHT
============================================================ */

Drone.hasMany(Flight, {
  foreignKey: "droneId",
  onDelete: "SET NULL",
});

Flight.belongsTo(Drone, {
  foreignKey: "droneId",
});

/* ============================================================
   DRONE ↔ MAINTENANCE
============================================================ */

Drone.hasMany(Maintenance, {
  foreignKey: "droneId",
  onDelete: "SET NULL",
});

Maintenance.belongsTo(Drone, {
  foreignKey: "droneId",
});

/* ============================================================
   USER ↔ PAYMENT ORDER
============================================================ */

User.hasMany(PaymentOrder, {
  foreignKey: "userId",
  onDelete: "SET NULL",
});

PaymentOrder.belongsTo(User, {
  foreignKey: "userId",
});

PaymentOrder.hasMany(UserPaymentCancellation, {
  foreignKey: "paymentOrderId",
  onDelete: "SET NULL",
});

/* ============================================================
   USER ↔ PAYMENT CANCELLATION (checkout abandon / user cancel)
============================================================ */

User.hasMany(UserPaymentCancellation, {
  foreignKey: "userId",
  onDelete: "CASCADE",
});

UserPaymentCancellation.belongsTo(User, {
  foreignKey: "userId",
});

UserPaymentCancellation.belongsTo(PaymentOrder, {
  foreignKey: "paymentOrderId",
  onDelete: "SET NULL",
});

/* ============================================================
   EXPORT
============================================================ */

export {
  sequelize,
  User,
  Flight,
  Pilot,
  Maintenance,
  UserOption,
  Contact,
  Drone,
  PaymentOrder,
  UserPaymentCancellation,
};
