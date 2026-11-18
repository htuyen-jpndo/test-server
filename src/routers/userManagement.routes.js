import express from "express";
import {
  getAllUsers,
  getUserDetails,
  getUserFlights,
  getUserMaintenances,
  getAdminStats,
  getAdminPayments,
  createUser,
  deleteUser,
  loginAsUser,
  updateUserStatus,
  adminUpsertUserPayment,
  adminSetUserAutoRenew,
  getAdminPaymentCancellations,
  deleteAdminPaymentCancellation,
  adminCreateUserWithManualPayment,
  adminCreateManualPaymentOrderForUser,
  adminListUserPaymentOrders,
  adminGatewayRefundPaymentOrder,
} from "../controllers/userManagement.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Tất cả routes đều yêu cầu admin
router.use(authMiddleware);
router.use(adminMiddleware);

// User management routes
router.get("/users", getAllUsers);
router.post("/users", createUser);
router.post("/users/manual-subscription", adminCreateUserWithManualPayment);
router.get("/users/:userId", getUserDetails);
router.delete("/users/:userId", deleteUser);
router.patch("/users/:userId/status", updateUserStatus);
router.get("/users/:userId/flights", getUserFlights);
router.get("/users/:userId/maintenances", getUserMaintenances);
router.post("/users/:userId/login-as", loginAsUser);
router.patch("/users/:userId/payment", adminUpsertUserPayment);
router.get("/users/:userId/payment-orders", adminListUserPaymentOrders);
router.post("/users/:userId/payment-orders", adminCreateManualPaymentOrderForUser);
router.post(
  "/users/:userId/payment-orders/:orderId/gateway-refund",
  adminGatewayRefundPaymentOrder
);
router.patch("/users/:userId/auto-renew", adminSetUserAutoRenew);

// Stats route
router.get("/stats", getAdminStats);
router.get("/payments", getAdminPayments);
router.get("/payment-cancellations", getAdminPaymentCancellations);
router.delete("/payment-cancellations/:id", deleteAdminPaymentCancellation);

export default router;
