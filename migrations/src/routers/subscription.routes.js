import express from "express";
import { auth } from "../middlewares/auth.js";
import { getMySubscription, setMyAutoRenew } from "../controllers/subscription.controller.js";

const router = express.Router();

router.get("/me", auth, getMySubscription);
router.patch("/auto-renew", auth, setMyAutoRenew);

export default router;
