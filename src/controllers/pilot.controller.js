import { Pilot } from "../models/index.js";

const pilotAttributes = [
  "id", "userId", "fullName", "birthDate", "organization",
  "phone", "email", "emergencyContact",
  "certificateType", "limitation", "certificateNumber", "issuedDate", "expiredDate",
  "totalFlightHours", "medicalCheckDate",
  "createdAt", "updatedAt"
];

export async function getPilots(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const pilots = await Pilot.findAll({
      where: { userId },
      attributes: pilotAttributes,
      order: [["fullName", "ASC"]],
    });
    res.status(200).json(pilots);
  } catch (err) {
    console.error("❌ getPilots error:", err);
    res.status(500).json({ error: "Failed to fetch pilots" });
  }
}

/** Chi tiết một pilot (chỉ khi pilot thuộc user đăng nhập) */
export async function getPilotById(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const pilot = await Pilot.findOne({
      where: { id, userId },
      attributes: pilotAttributes,
    });
    if (!pilot) return res.status(404).json({ error: "Pilot not found" });
    res.status(200).json(pilot);
  } catch (err) {
    console.error("❌ getPilotById error:", err);
    res.status(500).json({ error: "Failed to fetch pilot" });
  }
}

/** Tạo pilot mới — luôn gán vào danh sách của user đăng nhập */
export async function createPilot(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const {
      fullName, birthDate, organization, phone, email, emergencyContact,
      certificateType, limitation, certificateNumber, issuedDate, expiredDate,
      totalFlightHours, medicalCheckDate
    } = req.body;

    if (!fullName || !fullName.toString().trim()) {
      return res.status(400).json({ error: "fullName is required" });
    }

    const pilot = await Pilot.create({
      userId,
      fullName: fullName.toString().trim(),
      birthDate: birthDate || null,
      organization: organization ?? null,
      phone: phone ?? null,
      email: email ?? null,
      emergencyContact: emergencyContact ?? null,
      certificateType: certificateType ?? null,
      limitation: limitation ?? null,
      certificateNumber: certificateNumber ?? null,
      issuedDate: issuedDate ?? null,
      expiredDate: expiredDate ?? null,
      totalFlightHours: totalFlightHours ?? null,
      medicalCheckDate: medicalCheckDate ?? null,
    });
    res.status(201).json(pilot);
  } catch (err) {
    console.error("❌ createPilot error:", err);
    res.status(500).json({ error: "Failed to create pilot" });
  }
}

/** Cập nhật pilot (chỉ pilot thuộc user đăng nhập) */
export async function updatePilot(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const pilot = await Pilot.findOne({ where: { id, userId } });
    if (!pilot) return res.status(404).json({ error: "Pilot not found" });

    const allowed = [
      "fullName", "birthDate", "organization", "phone", "email", "emergencyContact",
      "certificateType", "limitation", "certificateNumber", "issuedDate", "expiredDate",
      "totalFlightHours", "medicalCheckDate"
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.fullName !== undefined && !updates.fullName?.toString().trim()) {
      return res.status(400).json({ error: "fullName cannot be empty" });
    }

    await pilot.update(updates);
    res.status(200).json(pilot);
  } catch (err) {
    console.error("❌ updatePilot error:", err);
    res.status(500).json({ error: "Failed to update pilot" });
  }
}

/** Xóa pilot (chỉ pilot thuộc user đăng nhập; flight.pilotId sẽ thành null nếu có) */
export async function deletePilot(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const pilot = await Pilot.findOne({ where: { id, userId } });
    if (!pilot) return res.status(404).json({ error: "Pilot not found" });

    await pilot.destroy();
    res.status(200).json({ message: "Pilot deleted" });
  } catch (err) {
    console.error("❌ deletePilot error:", err);
    res.status(500).json({ error: "Failed to delete pilot" });
  }
}
