import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { isUserSuspended, sendSuspendedAccountResponse } from "../utils/userStatus.js";

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findByPk(decoded.id);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    if (isUserSuspended(user)) {
      return sendSuspendedAccountResponse(res);
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ message: "Invalid token" });
  }
};

export const adminMiddleware = async (req, res, next) => {
  try {
    // Đảm bảo authMiddleware đã được gọi trước
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Kiểm tra quyền admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin privileges required." });
    }

    next();
  } catch (err) {
    console.error("Admin middleware error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Middleware để scope flights theo role: user chỉ xem của mình, admin xem tất cả
export const flightScope = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Admin xem tất cả, user chỉ xem flights của mình
    if (req.user.role === "admin") {
      req.flightScope = {}; // Không filter gì cả
    } else {
      req.flightScope = { userId: req.user.id }; // Chỉ flights của user
    }

    next();
  } catch (err) {
    console.error("Flight scope error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Middleware để kiểm tra user có phải owner của flight hoặc là admin
export const checkFlightOwnerOrAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Missing flight id" });
    }

    // Tìm flight
    const { Flight } = await import("../models/flight.model.js");
    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId)) {
      return res.status(400).json({ error: "Invalid flight id" });
    }
    const flight = await Flight.findByPk(numericId);

    if (!flight) {
      return res.status(404).json({ error: "Flight not found" });
    }

    // Admin có quyền sửa/xóa tất cả
    if (req.user.role === "admin") {
      req.flight = flight; // Lưu flight vào req để controller dùng
      return next();
    }

    // User thường chỉ sửa/xóa flight của mình
    if (flight.userId != req.user.id) {
      return res.status(403).json({ 
        message: "Access denied. You can only modify your own flights." 
      });
    }

    req.flight = flight; // Lưu flight vào req để controller dùng
    next();
  } catch (err) {
    console.error("Check flight owner error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Middleware để scope maintenance theo role: user chỉ xem của mình, admin xem tất cả
export const maintenanceScope = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Admin xem tất cả, user chỉ xem maintenance của mình
    if (req.user.role === "admin") {
      req.maintenanceScope = {}; // Không filter gì cả
    } else {
      req.maintenanceScope = { userId: req.user.id }; // Chỉ maintenance của user
    }

    next();
  } catch (err) {
    console.error("Maintenance scope error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Middleware để kiểm tra user có phải owner của maintenance hoặc là admin
export const checkMaintenanceOwnerOrAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Missing maintenance id" });
    }

    // Tìm maintenance
    const Maintenance = (await import("../models/maintenance.model.js")).default;
    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId)) {
      return res.status(400).json({ error: "Invalid maintenance id" });
    }
    const maintenance = await Maintenance.findByPk(numericId);

    if (!maintenance) {
      return res.status(404).json({ error: "Maintenance not found" });
    }

    // Admin có quyền sửa/xóa tất cả
    if (req.user.role === "admin") {
      req.maintenance = maintenance; // Lưu maintenance vào req để controller dùng
      return next();
    }

    // User thường chỉ sửa/xóa maintenance của mình
    if (maintenance.userId != req.user.id) {
      return res.status(403).json({ 
        message: "Access denied. You can only modify your own maintenance records." 
      });
    }

    req.maintenance = maintenance; // Lưu maintenance vào req để controller dùng
    next();
  } catch (err) {
    console.error("Check maintenance owner error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};