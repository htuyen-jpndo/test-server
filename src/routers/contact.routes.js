import express from "express";
import {
  submitContact,
  getAllContacts,
  getContactById,
  updateContactStatus,
} from "../controllers/contact.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public: gửi form liên hệ (không cần đăng nhập)
router.post("/", submitContact);

// Admin: xem danh sách, chi tiết, cập nhật trạng thái
router.get("/", authMiddleware, adminMiddleware, getAllContacts);
router.get("/:id", authMiddleware, adminMiddleware, getContactById);
router.patch("/:id", authMiddleware, adminMiddleware, updateContactStatus);

export default router;
