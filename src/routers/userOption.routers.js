import express from "express";
import {
  getUserOptions,
  createUserOption,
  deleteUserOption,
} from "../controllers/userOption.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
const router = express.Router();
router.use(authMiddleware);
router.get("/", getUserOptions);
router.post("/", createUserOption);
router.delete("/:id", deleteUserOption);

export default router;
