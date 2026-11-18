import { Flight, Pilot, Drone } from "../models/index.js";
import { Op } from "sequelize";
import { sequelize } from "../config/db.js";
import { recalculatePilotTotalFlightHoursForPilotIds } from "../utils/pilotFlightHours.js";

async function syncPilotHoursFromFlights(pilotIds) {
  try {
    await recalculatePilotTotalFlightHoursForPilotIds(
      Array.isArray(pilotIds) ? pilotIds : [pilotIds]
    );
  } catch (e) {
    console.error("⚠️ syncPilotHoursFromFlights:", e?.message || e);
  }
}

const flightIncludes = [
  { model: Pilot, as: "Pilot", attributes: ["id", "fullName", "organization", "certificateType", "certificateNumber", "expiredDate"] },
  { model: Drone, as: "Drone", attributes: ["id", "droneName", "registrationCode", "manufacturer", "modelType", "serialNumber"], required: false },
];

function parseDatePart(value) {
  if (!value || typeof value !== "string") return null;
  const dateOnly = value.trim().split("T")[0].split(" ")[0];
  const parts = dateOnly.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return [y, m, d];
}

export async function saveFlight(req, res) {
  try {
    const {
      pilotId,
      droneId,
      drone,
      purpose,
      location,
      takeoffTime,
      landTime,
      duration,
      preFlightChecks,
      postFlightChecks,
      checklistRemarks,
      checklistNotes,
      postLanding 
    } = req.body;

    if (!drone || !purpose) {
      return res.status(400).json({ error: "Missing required fields: drone, purpose" });
    }

    // Validation cho checklistRemarks
    if (checklistRemarks !== undefined && checklistRemarks !== null) {
      if (!Array.isArray(checklistRemarks)) {
        return res.status(400).json({ 
          error: "checklistRemarks must be an array" 
        });
      }
      
      // Validate từng phần tử trong array
      for (let i = 0; i < checklistRemarks.length; i++) {
        const entry = checklistRemarks[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return res.status(400).json({ 
            error: `checklistRemarks[${i}] must be an object` 
          });
        }
        
        // item và remarks phải là string hoặc null/undefined
        if (entry.item !== undefined && entry.item !== null && typeof entry.item !== 'string') {
          return res.status(400).json({ 
            error: `checklistRemarks[${i}].item must be a string or null` 
          });
        }
        
        if (entry.remarks !== undefined && entry.remarks !== null && typeof entry.remarks !== 'string') {
          return res.status(400).json({ 
            error: `checklistRemarks[${i}].remarks must be a string or null` 
          });
        }
      }
    }

    // Validation cho checklistNotes
    if (checklistNotes !== undefined && checklistNotes !== null && typeof checklistNotes !== 'string') {
      return res.status(400).json({ 
        error: "checklistNotes must be a string" 
      });
    }

    function secToHMS(sec) {
      const h = String(Math.floor(sec / 3600)).padStart(2, "0");
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      return `${h}:${m}:${s}`;
    }
    let sec = Number(duration);

    // Nếu FE gửi sai format hoặc null → fallback 0
    if (isNaN(sec) || sec < 0) sec = 0;

    const formattedDuration = secToHMS(sec);

    // Debug dữ liệu nhận từ frontend
    console.log("POST DATA RECEIVED:", postLanding);
    console.log("===== 🔵 RAW FRONTEND PAYLOAD RECEIVED 🔵 =====");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("==============================================");

    const userId = req.user?.id;
    // Lưu dữ liệu flight
    const flight = await Flight.create({
      pilotId: pilotId || null,
      droneId: droneId || null,
      userId: req.user.id,
      drone,
      purpose,
      location,
      takeoffTime,
      landTime,
      duration: formattedDuration,
      preFlightChecks,
      postFlightChecks,
      checklistRemarks,
      checklistNotes,
      postLanding
    });

    const flightWithRelations = await Flight.findByPk(flight.id, { include: flightIncludes });
    await syncPilotHoursFromFlights(flight.pilotId);
    res.status(201).json({ message: "✅ Flight saved successfully", flight: flightWithRelations || flight });
  } catch (err) {
    console.error("❌ Error saving flight:", err);
    res.status(500).json({ error: "Server error" });
  }
}


export async function createFlight(req, res) {
  try {
    const data = req.body;
    const flight = await Flight.create(data);
    await syncPilotHoursFromFlights(flight.pilotId);
    res.status(201).json({ message: "Flight saved successfully", flight });
  } catch (err) {
    console.error("❌ Error saving flight:", err);
    res.status(500).json({ error: "Failed to save flight" });
  }
}

/** GET /api/flights/filter — BE chỉ lọc drone + start + end. FE tự filter theo Pilot.fullName nếu cần. */
export async function getFilteredFlights(req, res) {
  try {
    const { drone, start, end } = req.query;
    const where = req.flightScope ? { ...req.flightScope } : {};

    if (drone) {
      where.drone = { [Op.like]: `%${drone}%` };
    }

    if (start || end) {
      where.takeoffTime = {};
      const startParts = parseDatePart(start);
      if (startParts) {
        const [y, m, d] = startParts;
        where.takeoffTime[Op.gte] = new Date(y, m - 1, d, 0, 0, 0);
      }
      const endParts = parseDatePart(end);
      if (endParts) {
        const [y, m, d] = endParts;
        where.takeoffTime[Op.lte] = new Date(y, m - 1, d, 23, 59, 59, 999);
      }
    }

    const flights = await Flight.findAll({
      where,
      include: flightIncludes,
      order: [["takeoffTime", "DESC"]],
    });

    res.status(200).json({ flights });
  } catch (err) {
    console.error("❌ getFilteredFlights error:", err);
    res.status(500).json({ error: "Filter error" });
  }
}

/** GET /api/flights/filter-by-pilot — lọc theo drone + pilotId + start/end (ngày tháng). Chỉ lọc theo id, không theo tên. */
export async function getFilteredFlightsByDronePilotDate(req, res) {
  try {
    const { drone, start, end, pilotId } = req.query;
    const where = req.flightScope ? { ...req.flightScope } : {};

    if (drone) {
      where.drone = { [Op.like]: `%${drone}%` };
    }

    if (pilotId) {
      where.pilotId = pilotId;
    }

    if (start || end) {
      where.takeoffTime = {};
      const startParts = parseDatePart(start);
      if (startParts) {
        const [y, m, d] = startParts;
        where.takeoffTime[Op.gte] = new Date(y, m - 1, d, 0, 0, 0);
      }
      const endParts = parseDatePart(end);
      if (endParts) {
        const [y, m, d] = endParts;
        where.takeoffTime[Op.lte] = new Date(y, m - 1, d, 23, 59, 59, 999);
      }
    }

    const flights = await Flight.findAll({
      where,
      include: flightIncludes,
      order: [["takeoffTime", "DESC"]],
    });

    res.status(200).json({ flights });
  } catch (err) {
    console.error("❌ getFilteredFlightsByDronePilotDate error:", err);
    res.status(500).json({ error: "Filter error" });
  }
}
export async function getFlights(req, res) {
  try {
    const where = req.flightScope ? { ...req.flightScope } : {};
    const flights = await Flight.findAll({
      where,
      include: flightIncludes,
      order: [["createdAt", "DESC"]],
    });
    res.status(200).json(flights);
  } catch (err) {
    console.error("❌ getFlights error:", err?.message || err);
    if (err?.original?.sqlMessage) console.error("   SQL:", err.original.sqlMessage);
    res.status(500).json({ error: "Cannot fetch flights" });
  }
}

/** GET /api/flights/by-pilot/:pilotId — lọc flight theo pilot id + phạm vi thời gian (start, end). */
export async function getFlightsByPilotId(req, res) {
  try {
    const { pilotId } = req.params;
    const { start, end } = req.query;
    if (!pilotId) {
      return res.status(400).json({ error: "pilotId is required" });
    }
    const where = req.flightScope ? { ...req.flightScope } : {};
    where.pilotId = pilotId;

    if (start || end) {
      where.takeoffTime = {};
      const startParts = parseDatePart(start);
      if (startParts) {
        const [y, m, d] = startParts;
        where.takeoffTime[Op.gte] = new Date(y, m - 1, d, 0, 0, 0);
      }
      const endParts = parseDatePart(end);
      if (endParts) {
        const [y, m, d] = endParts;
        where.takeoffTime[Op.lte] = new Date(y, m - 1, d, 23, 59, 59, 999);
      }
    }

    const flights = await Flight.findAll({
      where,
      include: flightIncludes,
      order: [["takeoffTime", "DESC"]],
    });
    res.status(200).json(flights);
  } catch (err) {
    console.error("❌ getFlightsByPilotId error:", err);
    res.status(500).json({ error: "Cannot fetch flights" });
  }
}

export async function deleteFlights(req, res) {
  try {
    await Flight.destroy({ where: {}, truncate: true });
    res.status(200).json({ message: "✅ All flight records deleteed successfully." });
  } catch (err) {
    console.error("❌ Error deleteing flights:", err);
    res.status(500).json({ error: "Server error while deleteing flights." });
  }
}


export async function resetFlights(req, res) {
  try {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0;");
    await sequelize.query("TRUNCATE TABLE maintenance_records;");
    await sequelize.query("TRUNCATE TABLE flights;");
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1;");

    res.json({ message: "All flight data reset successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset flights" });
  }
}

//get all flights

export async function updateFlight(req, res) {
  try {
    const updates = req.body;

    // Flight đã được kiểm tra và lưu vào req.flight bởi middleware checkFlightOwnerOrAdmin
    const flight = req.flight;
    if (!flight) return res.status(404).json({ error: 'Flight not found' });

    // Hàm chuyển từ giây → HH:MM:SS
    function secToHMS(sec) {
      const h = String(Math.floor(sec / 3600)).padStart(2, "0");
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      return `${h}:${m}:${s}`;
    }

    // Validation cho checklistRemarks nếu có trong updates
    if (updates.checklistRemarks !== undefined) {
      if (updates.checklistRemarks !== null) {
        if (!Array.isArray(updates.checklistRemarks)) {
          return res.status(400).json({ 
            error: "checklistRemarks must be an array" 
          });
        }
        
        // Validate từng phần tử trong array
        for (let i = 0; i < updates.checklistRemarks.length; i++) {
          const entry = updates.checklistRemarks[i];
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return res.status(400).json({ 
              error: `checklistRemarks[${i}] must be an object` 
            });
          }
          
          if (entry.item !== undefined && entry.item !== null && typeof entry.item !== 'string') {
            return res.status(400).json({ 
              error: `checklistRemarks[${i}].item must be a string or null` 
            });
          }
          
          if (entry.remarks !== undefined && entry.remarks !== null && typeof entry.remarks !== 'string') {
            return res.status(400).json({ 
              error: `checklistRemarks[${i}].remarks must be a string or null` 
            });
          }
        }
      }
    }

    // Validation cho checklistNotes nếu có trong updates
    if (updates.checklistNotes !== undefined && updates.checklistNotes !== null && typeof updates.checklistNotes !== 'string') {
      return res.status(400).json({ 
        error: "checklistNotes must be a string" 
      });
    }

    // Nếu FE gửi duration
    if (updates.duration !== undefined) {

      // Trường hợp FE gửi "HH:MM:SS" → giữ nguyên
      if (typeof updates.duration === "string" && updates.duration.includes(":")) {
        // đảm bảo format chuẩn 00:00:00
        const parts = updates.duration.split(":");
        const h = String(Number(parts[0] || 0)).padStart(2, "0");
        const m = String(Number(parts[1] || 0)).padStart(2, "0");
        const s = String(Number(parts[2] || 0)).padStart(2, "0");
        updates.duration = `${h}:${m}:${s}`;
      }

      else {
        // FE gửi số giây (string hoặc number)
        let sec = Number(updates.duration);
        if (isNaN(sec) || sec < 0) sec = 0;
        updates.duration = secToHMS(sec);
      }
    }

    const prevPilotId = flight.pilotId;
    await flight.update(updates);
    await flight.reload();

    await syncPilotHoursFromFlights([prevPilotId, flight.pilotId]);

    const flightWithPilot = await Flight.findByPk(flight.id, { include: flightIncludes });
    res.json({ message: 'Flight updated', flight: flightWithPilot || flight });

  } catch (err) {
    console.error('❌ updateFlight error:', err);
    res.status(500).json({ error: 'Failed to update flight' });
  }
}

export async function deleteFlightById(req, res) {
  try {
    // Flight đã được kiểm tra và lưu vào req.flight bởi middleware checkFlightOwnerOrAdmin
    const flight = req.flight;
    if (!flight) return res.status(404).json({ error: 'Flight not found' });

    const pilotId = flight.pilotId;
    await flight.destroy();
    await syncPilotHoursFromFlights(pilotId);

    res.json({ message: 'Flight deleted' });
  } catch (err) {
    console.error('❌ deleteFlightById error:', err);
    res.status(500).json({ error: 'Failed to delete flight' });
  }
}
