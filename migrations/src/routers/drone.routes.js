import express from "express";
import {
  getDrones,
  getAllDronesForAdmin,
  getDroneById,
  createDrone,
  updateDrone,
  deleteDrone,
} from "../controllers/drone.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();
router.use(authMiddleware);

router.get("/", getDrones);
router.get("/all", adminMiddleware, getAllDronesForAdmin);
router.get("/:id", getDroneById);
router.post("/", createDrone);
router.patch("/:id", updateDrone);
router.delete("/:id", deleteDrone);

export default router;
