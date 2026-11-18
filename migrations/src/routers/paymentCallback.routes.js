import express from "express";
import {
  checkoutByUid,
  getPaymentOrder,
  getPaymentResultByToken,
  initPaymentOrder,
  listMyPaymentOrders,
  paymentCallback,
  paymentReturn,
} from "../controllers/paymentCallback.controller.js";
import { auth } from "../middlewares/auth.js";

const router = express.Router();

router.get("/callback/:notifyToken", paymentCallback);
router.get("/callback", paymentCallback);
router.get("/callbacka", paymentCallback);
router.get("/auto-renew/callback/:notifyToken", paymentCallback);
router.get("/auto-renew/callback", paymentCallback);
router.get("/return", paymentReturn);

router.get("/orders", auth, listMyPaymentOrders);
router.post("/checkout/init", auth, initPaymentOrder);
router.post("/order/init", auth, initPaymentOrder);
router.get("/checkout/:uid", checkoutByUid);
router.get("/result/:r", getPaymentResultByToken);

router.get("/order/:cod", auth, getPaymentOrder);

export default router;

