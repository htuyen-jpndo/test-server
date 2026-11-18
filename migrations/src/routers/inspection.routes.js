import express from "express";
import { getInspections } from "../controllers/inspection.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();
router.get("/", authMiddleware, getInspections);

export default router;
