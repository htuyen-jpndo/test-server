import express from "express";
import {
  getPilots,
  getPilotById,
  createPilot,
  updatePilot,
  deletePilot,
} from "../controllers/pilot.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { enforcePilotCreatePlanLimit } from "../middlewares/pilotPlan.middleware.js";

const router = express.Router();
router.use(authMiddleware);

router.get("/", getPilots);
router.get("/:id", getPilotById);
router.post("/", enforcePilotCreatePlanLimit, createPilot);
router.patch("/:id", updatePilot);
router.delete("/:id", deletePilot);

export default router;
