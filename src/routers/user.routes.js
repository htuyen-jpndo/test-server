import express from "express";
import {
  registerUser,
  loginUser,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  getMe,
  updateMe,
  recordUserPaymentCancellation,
} from "../controllers/user.controller.js";
import { auth } from "../middlewares/auth.js";
// Ví dụ sử dụng adminMiddleware:
// import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";
// router.get("/admin-only-route", authMiddleware, adminMiddleware, yourController);

const router = express.Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/forgot-password", forgotPassword);
router.post("/verify-reset-code", verifyResetCode);
router.post("/reset-password", resetPassword);
router.get("/me", auth, getMe);
router.patch("/me", auth, updateMe);
router.post("/me/payment-cancellations", auth, recordUserPaymentCancellation);
export default router;
