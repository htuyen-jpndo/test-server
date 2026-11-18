import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

import flightRoutes from "./src/routers/flight.routes.js";
import userRoutes from "./src/routers/user.routes.js";
import inspectionRoutes from "./src/routers/inspection.routes.js";
import maintenanceRoutes from "./src/routers/maintenance.routes.js";
import userManagementRoutes from "./src/routers/userManagement.routes.js";

import { connectDB, sequelize } from "./src/config/db.js";
import { runMigrations } from "./src/config/runMigrations.js";
import { User } from "./src/models/user.model.js";
import bcrypt from "bcryptjs";

import userOptionRoutes from "./src/routers/userOption.routers.js";
import pilotRoutes from "./src/routers/pilot.routes.js";
import droneRoutes from "./src/routers/drone.routes.js";
import contactRoutes from "./src/routers/contact.routes.js";
import paymentCallbackRoutes from "./src/routers/paymentCallback.routes.js";
import subscriptionRoutes from "./src/routers/subscription.routes.js";
import { normalizeDoubleQuestionQuery } from "./src/middlewares/normalizeDoubleQuestionQuery.js";
import { auth } from "./src/middlewares/auth.js";
import { requireActiveSubscription } from "./src/middlewares/subscription.middleware.js";
import { startBankFreeAutoRenewWorker } from "./src/jobs/bankFreeAutoRenew.worker.js";
// import "./models/index.js"; 
import "./src/models/index.js"; 

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// So we can rely on X-Forwarded-For / req.ip behind reverse proxies.
app.set("trust proxy", true);

// Before any handler reads req.query — fixes malformed notify URLs (`?s=...?gid=...`).
app.use(normalizeDoubleQuestionQuery);

// app.use(
//   cors({
//     origin: [
//       "http://localhost:5173",             
//       "http://localhost:5500",             
//       "https://flight-report-client.vercel.app" 
//     ],
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"]
//   })
// );
// app.use(cors());
// app.options("*", cors());
// app.use(
//   cors({
//     origin: true,
//     credentials: true
//   })
// );


// const allowedOrigins = (process.env.CORS_ORIGINS || "")
//   .split(",")
//   .map((o) => o.trim())
//   .filter(Boolean);

// const corsOptions = {
//   origin: (origin, callback) => {
//     // Cho phép requests không có origin (vd: Postman, mobile app)
//     if (!origin) return callback(null, true);
//     if (allowedOrigins.includes(origin)) return callback(null, true);
//     callback(null, false);
//   },
//   methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//   allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
//   credentials: true,
// };
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim());

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }

    return callback(new Error("CORS not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// API ROUTES
// ==========================
app.use("/api/users", userRoutes);
app.use("/api/user", userManagementRoutes);
app.use("/api/payment", paymentCallbackRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/flights", auth, requireActiveSubscription, flightRoutes);
app.use("/api/inspections", auth, requireActiveSubscription, inspectionRoutes);
app.use("/api/maintenance", auth, requireActiveSubscription, maintenanceRoutes);
app.use("/api/pilots", auth, requireActiveSubscription, pilotRoutes);
app.use("/api/drones", auth, requireActiveSubscription, droneRoutes);
app.use("/api/contacts", auth, requireActiveSubscription, contactRoutes); 

// ==========================
// API LẤY GOOGLE MAP KEY
// ==========================
app.get("/api/google-key", (req, res) => {
  res.json({ key: process.env.API_KEY });
});

app.get("/", (req, res) => {
  res.json({ message: "Backend is running" });
});

// Render / load balancer: cần phản hồi nhanh, không chờ DB
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// connectDB();
// await sequelize.sync();

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`🚀 Server running: http://localhost:${PORT}`);
// });
app.use("/api/user-options", auth, requireActiveSubscription, userOptionRoutes);

async function ensureAdminExists() {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@gmail.com").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  try {
    const count = await User.count();
    console.log("📊 Users trong DB:", count);

    const existing = await User.findOne({ where: { email: adminEmail } });
    if (existing) {
      if (existing.role !== "admin") {
        existing.role = "admin";
        await existing.save();
        console.log("✅ Admin: đã cập nhật role cho", adminEmail);
      } else {
        console.log("✅ Admin đã tồn tại:", adminEmail);
      }
      return;
    }
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    await User.create({
      name: "Admin User",
      email: adminEmail,
      password: hashedPassword,
      role: "admin",
    });
    console.log("✅ Admin mặc định đã được tạo:", adminEmail, "/", adminPassword);
  } catch (err) {
    console.error("⚠️ Không tạo được admin:", err.message);
    console.error(err.stack);
  }
}

const PORT = Number(process.env.PORT) || 5000;

const startServer = () => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT} (0.0.0.0)`);
  });

  (async () => {
    try {
      await connectDB();
      await runMigrations(sequelize);
      await sequelize.sync();
      await ensureAdminExists();
      startBankFreeAutoRenewWorker();
      console.log("✅ Database ready");
    } catch (err) {
      console.error("❌ Database init failed:", err);
      process.exit(1);
    }
  })();
};

startServer();