import express from "express";
import { auth } from "../middlewares/auth.js";
import { getMySubscription, setMyAutoRenew } from "../controllers/subscription.controller.js";
import { getChangeCardInfo, initChangeCard } from "../controllers/changeCard.controller.js";

const router = express.Router();

router.get("/me", auth, getMySubscription);
router.patch("/auto-renew", auth, setMyAutoRenew);
router.get("/change-card", auth, getChangeCardInfo);
router.post("/change-card/init", auth, initChangeCard);

export default router;
