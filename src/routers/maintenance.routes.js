import express from "express";
import {
  getAllMaintenances,
  createMaintenance,
  updateMaintenance,
  deleteMaintenance,
  filterMaintenances,
  getMaintenanceDetails,
  addMaintenanceDetail,
  deleteMaintenanceDetail,
  deleteMaintenances,
  resetMaintenances,
} from "../controllers/maintenance.controller.js";
import { authMiddleware, adminMiddleware, maintenanceScope, checkMaintenanceOwnerOrAdmin } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(authMiddleware);

// Xem maintenance (scope theo role)
router.get("/", maintenanceScope, getAllMaintenances);
router.get("/filter", maintenanceScope, filterMaintenances);

// User + Admin đều tạo được
router.post("/", createMaintenance);

// User sửa/xóa của mình, admin sửa/xóa tất cả
router.patch("/:id", checkMaintenanceOwnerOrAdmin, updateMaintenance);
router.delete("/:id", checkMaintenanceOwnerOrAdmin, deleteMaintenance);

// Chỉ admin
router.delete("/delete", adminMiddleware, deleteMaintenances);
router.delete("/reset", adminMiddleware, resetMaintenances);

/* ============================
   DETAIL ROUTES
============================ */
router.get("/details", getMaintenanceDetails);
router.post("/details", addMaintenanceDetail);
router.delete("/details/:id", deleteMaintenanceDetail);

export default router;
