import { UserOption } from "../models/userOption.model.js";
import { Pilot } from "../models/index.js";
import { serializeUserOptionForApi } from "../utils/time.js";

// Helper để format response chỉ với các field yêu cầu
const formatUserOptionResponse = (option) => {
  const serialized = serializeUserOptionForApi(option);
  return {
    id: serialized.id,
    type: serialized.type,
    value: serialized.value,
    userId: serialized.userId,
    createdAt: serialized.createdAt,
  };
};

/* ============================
   GET OPTIONS
   type=pilot → lấy từ bảng pilots (một nguồn duy nhất cho danh sách pilot của user)
   type khác → lấy từ user_options
============================ */
export const getUserOptions = async (req, res) => {
  try {
    const userId = req.user.id;
    const { type } = req.query;

    if (!type) {
      return res.status(400).json({ message: "type is required" });
    }

    // Danh sách pilot thống nhất từ bảng pilots (dùng cho cả hệ thống)
    if (type === "pilot") {
      const pilots = await Pilot.findAll({
        where: { userId },
        attributes: ["id", "userId", "fullName", "createdAt"],
        order: [["fullName", "ASC"]],
      });
      return res.json(
        pilots.map((p) => ({
          id: p.id,
          type: "pilot",
          value: p.fullName,
          userId: p.userId,
          createdAt: p.createdAt,
        }))
      );
    }

    const options = await UserOption.findAll({
      where: {
        userId,
        type,
        isActive: true,
      },
      order: [["createdAt", "ASC"]],
    });

    res.json(options.map(formatUserOptionResponse));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load options" });
  }
};

/* ============================
   CREATE OPTION
   type=pilot không tạo qua đây — dùng POST /api/pilots (danh sách pilot thống nhất từ bảng pilots)
============================ */
export const createUserOption = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { type, value } = req.body;

    if (!type || !value) {
      return res.status(400).json({ message: "type and value are required" });
    }

    if (type === "pilot") {
      return res.status(400).json({
        message: "Use POST /api/pilots to add pilots. Pilot list is managed in the pilots table.",
      });
    }

    const userId = req.user.id;

    const option = await UserOption.create({
      userId,
      type,
      value
    });

    res.status(201).json(formatUserOptionResponse(option));
  } catch (err) {
    console.error("createUserOption error:", err);
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ message: "Option already exists" });
    }
    res.status(500).json({ message: "Failed to create option" });
  }
};


/* ============================
   DELETE OPTION (HARD DELETE)
============================ */
export const deleteUserOption = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const option = await UserOption.findOne({
      where: { id, userId },
    });

    if (!option) {
      return res.status(404).json({ message: "Option not found" });
    }

    await option.destroy();

    res.json({ message: "Option deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete option" });
  }
};
