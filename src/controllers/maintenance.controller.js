import { Op } from "sequelize";
import Maintenance from "../models/maintenance.model.js";
import { UserOption } from "../models/userOption.model.js";
import { serializeMaintenanceForApi } from "../utils/time.js";
import { sequelize } from "../config/db.js";

export async function getAllMaintenances(req, res) {
  try {
    const where = req.maintenanceScope ? { ...req.maintenanceScope } : {};
    const all = await Maintenance.findAll({
      where,
      order: [["date", "DESC"]],
    });
    res.json(all.map((m) => serializeMaintenanceForApi(m)));
  } catch (err) {
    console.error("❌ GET /maintenance error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function createMaintenance(req, res) {
  try {
    const data = Array.isArray(req.body) ? req.body : [req.body];

    const normalized = data.map((r) => {
      let isoDate = null;
      if (r.date) {
        try {
          isoDate = new Date(new Date(r.date).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }))
            .toISOString()
            .split("T")[0];
        } catch {
          isoDate = null;
        }
      }
      
      // Xác định userId: user thường chỉ có thể tạo cho chính mình, admin có thể tạo cho user khác
      let targetUserId = req.user.id;
      if (req.user.role === "admin" && r.userId) {
        // Admin có thể chỉ định userId khác
        targetUserId = r.userId;
      } else if (req.user.role !== "admin" && r.userId != null && r.userId != req.user.id) {
        // User thường không thể tạo maintenance cho user khác
        return null;
      }

      const { userId, engineerId, droneId, ...rest } = r;
      return { ...rest, date: isoDate, userId: targetUserId, droneId: droneId || null };
    }).filter(Boolean); // Loại bỏ các record null (user cố gắng tạo cho user khác)

    const valid = normalized.filter((r) => r.drone && r.date);
    if (!valid.length) {
      return res
        .status(400)
        .json({ message: "Missing drone or date" });
    }

    const created = await Maintenance.bulkCreate(valid);
    res.status(201).json({
      message: "✅ Saved successfully",
      count: created.length,
    });
  } catch (err) {
    console.error("❌ POST /maintenance error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function updateMaintenance(req, res) {
  try {
    const updates = req.body;

    // Maintenance đã được kiểm tra và lưu vào req.maintenance bởi middleware checkMaintenanceOwnerOrAdmin
    const maintenance = req.maintenance;
    if (!maintenance) return res.status(404).json({ error: 'Maintenance not found' });

    // User thường không thể thay đổi userId, chỉ admin mới có thể
    if (updates.userId !== undefined) {
      if (req.user.role !== "admin") {
        // User thường không thể thay đổi userId
        delete updates.userId;
      }
    }

    // Normalize date if provided
    if (updates.date) {
      try {
        updates.date = new Date(
          new Date(updates.date).toLocaleString("en-US", {
            timeZone: "Asia/Tokyo",
          })
        )
          .toISOString()
          .split("T")[0];
      } catch {
        updates.date = null;
      }
    }

    // Update vào DB
    await maintenance.update(updates);

    await maintenance.reload();

    res.json({
      message: "Maintenance updated",
      maintenance: serializeMaintenanceForApi(maintenance),
    });
  } catch (err) {
    console.error("❌ PATCH /maintenance/:id error:", err);
    res.status(500).json({ error: "Failed to update maintenance" });
  }
}

export async function deleteMaintenance(req, res) {
  try {
    // Maintenance đã được kiểm tra và lưu vào req.maintenance bởi middleware checkMaintenanceOwnerOrAdmin
    const maintenance = req.maintenance;
    if (!maintenance) return res.status(404).json({ error: 'Maintenance not found' });

    await maintenance.destroy();

    res.json({ message: "Maintenance deleted" });
  } catch (err) {
    console.error("❌ DELETE /maintenance/:id error:", err);
    res.status(500).json({ error: "Failed to delete maintenance" });
  }
}

export async function filterMaintenances(req, res) {
  try {
    const { drone, start, end } = req.query;
    // Áp dụng scope từ middleware (user chỉ xem của mình, admin xem tất cả)
    const where = req.maintenanceScope ? { ...req.maintenanceScope } : {};

    if (drone) where.drone = { [Op.like]: `%${drone}%` };
    if (start && end) {
      where.date = { [Op.between]: [start, end] };
    } else if (start) {
      where.date = { [Op.gte]: start };
    } else if (end) {
      where.date = { [Op.lte]: end };
    }

    const results = await Maintenance.findAll({
      where,
      order: [["date", "DESC"]],
    });

    if (!results.length) {
      return res.json({ message: "No data found", data: [] });
    }

    res.json({ message: "Success", data: results.map(serializeMaintenanceForApi) });
  } catch (err) {
    console.error("❌ GET /maintenance/filter error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function getMaintenanceDetails(req, res) {
  try {
    const { userId } = req.query;

    // Xác định userId: nếu admin có thể xem của user khác, user thường chỉ xem của mình
    let targetUserId = userId;
    if (req.user.role !== "admin") {
      // User thường chỉ có thể xem detail của chính mình
      targetUserId = req.user.id;
    } else if (!targetUserId) {
      // Admin có thể không truyền userId để xem của chính mình
      targetUserId = req.user.id;
    }

    // Chỉ lấy từ UserOption (danh sách checklist items đã lưu của user)
    // KHÔNG lấy từ Maintenance records vì Maintenance.detail có thể chứa toàn bộ checklist đã tick (string dài)
    const options = await UserOption.findAll({
      where: {
        userId: targetUserId,
        type: "maintenance-detail",
        isActive: true,
      },
      attributes: ["id", "value"],
      order: [["createdAt", "ASC"]],
    });

    // Trả về cả id và value để có thể xóa được
    const details = options.map((o) => ({
      id: o.id,
      value: o.value,
    }));

    res.json(details);
  } catch (err) {
    console.error("❌ GET /maintenance/details error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function addMaintenanceDetail(req, res) {
  try {
    const { detail, userId } = req.body;

    if (!detail) {
      return res.status(400).json({ message: "detail is required" });
    }

    // Xác định userId: user thường chỉ có thể thêm detail cho chính mình, admin có thể thêm cho user khác
    let targetUserId = userId;
    if (req.user.role !== "admin") {
      // User thường chỉ có thể thêm detail cho chính mình
      targetUserId = req.user.id;
    } else if (!targetUserId) {
      // Admin có thể không truyền userId để thêm cho chính mình
      targetUserId = req.user.id;
    }

    // Kiểm tra xem detail đã tồn tại trong UserOption chưa
    const existing = await UserOption.findOne({
      where: {
        userId: targetUserId,
        type: "maintenance-detail",
        value: detail,
      },
    });

    if (existing) {
      return res.status(200).json({
        message: "Detail already exists",
        id: existing.id,
        value: existing.value,
      });
    }

    // Tạo UserOption để lưu detail vào danh sách options
    const newDetail = await UserOption.create({
      userId: targetUserId,
      type: "maintenance-detail",
      value: detail,
    });

    res.status(201).json({
      message: "✅ Detail added successfully",
      id: newDetail.id,
      value: newDetail.value,
    });
  } catch (err) {
    console.error("❌ POST /maintenance/details error:", err);
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ message: "Detail already exists" });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function deleteMaintenanceDetail(req, res) {
  try {
    const { id } = req.params;

    // User chỉ có thể xóa detail của chính mình, admin có thể xóa của bất kỳ ai
    const where = {
      id: id,
      type: "maintenance-detail",
    };

    if (req.user.role !== "admin") {
      where.userId = req.user.id;
    }

    const detailOption = await UserOption.findOne({ where });

    if (!detailOption) {
      return res.status(404).json({ message: "Detail option not found" });
    }

    await detailOption.destroy();

    res.json({
      message: "✅ Detail deleted successfully",
    });
  } catch (err) {
    console.error("❌ DELETE /maintenance/details/:id error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function deleteMaintenances(req, res) {
  try {
    await Maintenance.destroy({ where: {}, truncate: true });
    res.status(200).json({ message: "✅ All maintenance records deleted successfully." });
  } catch (err) {
    console.error("❌ Error deleting maintenances:", err);
    res.status(500).json({ error: "Server error while deleting maintenances." });
  }
}

export async function resetMaintenances(req, res) {
  try {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0;");
    await sequelize.query("TRUNCATE TABLE maintenance_records;");
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1;");

    res.json({ message: "All maintenance data reset successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset maintenances" });
  }
}
