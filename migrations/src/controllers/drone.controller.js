import { Drone } from "../models/index.js";

const droneAttributes = [
  "id", "userId", "droneName", "registrationCode", "manufacturer", "modelType",
  "serialNumber", "droneWeight", "purpose", "registrantName", "registrationExpiry",
  "remoteIdInfo", "remoteIdModelType", "remoteIdSerialNumber",
  "dailyInspectionItems", "periodicInspectionHistory",
  "insuranceCompany", "coverageAmount", "insuranceExpiry",
  "createdAt", "updatedAt"
];

export async function getDrones(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const where = { userId };
    const drones = await Drone.findAll({
      where,
      attributes: droneAttributes,
      order: [["droneName", "ASC"]],
    });
    res.status(200).json(drones);
  } catch (err) {
    console.error("❌ getDrones error:", err);
    res.status(500).json({ error: "Failed to fetch drones" });
  }
}

export async function getAllDronesForAdmin(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const drones = await Drone.findAll({
      attributes: droneAttributes,
      order: [["droneName", "ASC"]],
    });
    res.status(200).json(drones);
  } catch (err) {
    console.error("❌ getAllDronesForAdmin error:", err);
    res.status(500).json({ error: "Failed to fetch all drones" });
  }
}

export async function getDroneById(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const where = req.user.role === "admin" ? { id } : { id, userId };
    const drone = await Drone.findOne({
      where,
      attributes: droneAttributes,
    });
    if (!drone) return res.status(404).json({ error: "Drone not found" });
    res.status(200).json(drone);
  } catch (err) {
    console.error("❌ getDroneById error:", err);
    res.status(500).json({ error: "Failed to fetch drone" });
  }
}

export async function createDrone(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const targetUserId = req.user.role === "admin" && req.body.userId ? req.body.userId : userId;

    const {
      droneName, registrationCode, manufacturer, modelType, serialNumber,
      droneWeight, purpose, registrantName, registrationExpiry,
      remoteIdInfo, remoteIdModelType, remoteIdSerialNumber,
      dailyInspectionItems, periodicInspectionHistory,
      insuranceCompany, coverageAmount, insuranceExpiry
    } = req.body;

    const drone = await Drone.create({
      userId: targetUserId,
      droneName: droneName ?? null,
      registrationCode: registrationCode ?? null,
      manufacturer: manufacturer ?? null,
      modelType: modelType ?? null,
      serialNumber: serialNumber ?? null,
      droneWeight: droneWeight ?? null,
      purpose: purpose ?? null,
      registrantName: registrantName ?? null,
      registrationExpiry: registrationExpiry ?? null,
      remoteIdInfo: remoteIdInfo ?? null,
      remoteIdModelType: remoteIdModelType ?? null,
      remoteIdSerialNumber: remoteIdSerialNumber ?? null,
      dailyInspectionItems: dailyInspectionItems ?? null,
      periodicInspectionHistory: periodicInspectionHistory ?? null,
      insuranceCompany: insuranceCompany ?? null,
      coverageAmount: coverageAmount ?? null,
      insuranceExpiry: insuranceExpiry ?? null,
    });
    res.status(201).json(drone);
  } catch (err) {
    console.error("❌ createDrone error:", err);
    res.status(500).json({ error: "Failed to create drone" });
  }
}

export async function updateDrone(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const drone = await Drone.findOne({
      where: req.user.role === "admin" ? { id } : { id, userId },
    });
    if (!drone) return res.status(404).json({ error: "Drone not found" });

    const allowed = [
      "droneName", "registrationCode", "manufacturer", "modelType", "serialNumber",
      "droneWeight", "purpose", "registrantName", "registrationExpiry",
      "remoteIdInfo", "remoteIdModelType", "remoteIdSerialNumber",
      "dailyInspectionItems", "periodicInspectionHistory",
      "insuranceCompany", "coverageAmount", "insuranceExpiry"
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    await drone.update(updates);
    res.status(200).json(drone);
  } catch (err) {
    console.error("❌ updateDrone error:", err);
    res.status(500).json({ error: "Failed to update drone" });
  }
}

export async function deleteDrone(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const drone = await Drone.findOne({
      where: req.user.role === "admin" ? { id } : { id, userId },
    });
    if (!drone) return res.status(404).json({ error: "Drone not found" });

    await drone.destroy();
    res.status(200).json({ message: "Drone deleted" });
  } catch (err) {
    console.error("❌ deleteDrone error:", err);
    res.status(500).json({ error: "Failed to delete drone" });
  }
}
