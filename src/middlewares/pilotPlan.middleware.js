import { Pilot } from "../models/index.js";
import { getUserSubscriptionState } from "./subscription.middleware.js";

export async function enforcePilotCreatePlanLimit(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (req.user?.role === "admin") {
      return next();
    }

    const subscription = await getUserSubscriptionState(userId);
    if (subscription.status !== "active") {
      return next();
    }

    if (subscription.accountType !== "personal") {
      return next();
    }

    const pilotCount = await Pilot.count({ where: { userId } });
    if (pilotCount >= 1) {
      return res.status(403).json({
        error: "Personal plan allows only 1 pilot",
        code: "PERSONAL_PLAN_PILOT_LIMIT",
        limit: 1,
      });
    }

    return next();
  } catch (err) {
    console.error("❌ enforcePilotCreatePlanLimit error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
