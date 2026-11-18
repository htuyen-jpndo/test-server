// controllers/inspection.controller.js
import { Flight, Pilot } from "../models/index.js";
import { Op } from "sequelize";

export async function getInspections(req, res) {
  try {
    const { drone, start, end, userId } = req.query;
    if (!drone || !start || !end) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // Admin có thể xem inspection của user khác qua query userId; user thường chỉ xem của mình
    const targetUserId = req.user.role === "admin" && userId ? userId : req.user.id;

    // Bao phủ cả ngày theo JST
    const startDate = new Date(`${start}T00:00:00+09:00`);
    const endDate   = new Date(`${end}T23:59:59+09:00`);

    const flights = await Flight.findAll({
      where: {
        userId: targetUserId,
        drone: { [Op.like]: `%${drone}%` },
        takeoffTime: { [Op.between]: [startDate, endDate] },
      },
      include: [{ model: Pilot, as: "Pilot", attributes: ["id", "fullName"] }],
      order: [["takeoffTime", "ASC"]],
    });

    if (!flights.length) {
      return res.json({
        drone,
        period: { start, end },
        inspectors: [],
        flights: [],
        aggregated: { inspector: "-", records: [] },
      });
    }

    // Ép JSON nếu DB lưu TEXT
    const parseMaybeJson = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try {
          const j = JSON.parse(v);
          return Array.isArray(j) ? j : [];
        } catch {
          return [];
        }
      }
      return [];
    };

    // Parse checklistRemarks - trả về array of objects hoặc null
    const parseChecklistRemarks = (v) => {
      if (!v) return null;
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try {
          const j = JSON.parse(v);
          return Array.isArray(j) ? j : null;
        } catch {
          return null;
        }
      }
      if (typeof v === "object" && v !== null) {
        return Array.isArray(v) ? v : null;
      }
      return null;
    };

    // Parse postLanding JSON và structure theo yêu cầu
    const parsePostLanding = (postLandingData) => {
      if (!postLandingData) {
        return {
          noIssues: false,
          comment: null,
          flightSquawk: null,
          actionDate: null,
          correctiveAction: null,
        };
      }

      // Nếu là string, parse JSON
      let parsed = postLandingData;
      if (typeof postLandingData === "string") {
        try {
          parsed = JSON.parse(postLandingData);
        } catch {
          return {
            noIssues: false,
            comment: null,
            flightSquawk: null,
            actionDate: null,
            correctiveAction: null,
          };
        }
      }

      // Nếu parsed là object, extract các fields
      if (typeof parsed === "object" && parsed !== null) {
        return {
          noIssues: parsed.noIssues === true || parsed.noIssues === "true",
          comment: parsed.comment || null,
          flightSquawk: parsed.flightSquawk || null,
          actionDate: parsed.actionDate || null,
          correctiveAction: parsed.correctiveAction || null,
        };
      }

      return {
        noIssues: false,
        comment: null,
        flightSquawk: null,
        actionDate: null,
        correctiveAction: null,
      };
    };

    const flightsOut = flights.map((f) => {
      const preArr = parseMaybeJson(f.preFlightChecks).map(item => ({
        item, status: "OK", remarks: "Pre-flight check",
      }));
      const postArr = parseMaybeJson(f.postFlightChecks).map(item => ({
        item, status: "OK", remarks: "Post-flight check",
      }));

      const parseDurationToSeconds = (dur) => {
        if (dur === null || dur === undefined) return 0;
        if (typeof dur === "number" && Number.isFinite(dur)) return dur;
        const raw = String(dur).trim();
        if (!raw) return 0;
        if (/^\d+$/.test(raw)) return Number(raw);
        const m = raw.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
        if (!m) return 0;
        const h = Number(m[1] || 0);
        const min = Number(m[2] || 0);
        const s = Number(m[3] || 0);
        if (![h, min, s].every(Number.isFinite)) return 0;
        return h * 3600 + min * 60 + s;
      };

      return {
        id: f.id,
        date: new Date(f.takeoffTime).toLocaleDateString("ja-JP"),
        place: f.location || "",
        inspector: (f.Pilot && f.Pilot.fullName) ? f.Pilot.fullName : "",
        durationSec: parseDurationToSeconds(f.duration),
        pre: preArr,
        post: postArr,
        postLanding: parsePostLanding(f.postLanding),
        checklistRemarks: parseChecklistRemarks(f.checklistRemarks),
        checklistNotes: f.checklistNotes || null,
      };
    });

    const inspectors = Array.from(new Set(flightsOut.map(f => f.inspector).filter(Boolean)));

    const aggregatedRecords = [];
    for (const fl of flightsOut) {
      aggregatedRecords.push(...fl.pre, ...fl.post);
    }

    const aggregatedInspector =
      inspectors.length > 1
        ? `複数（${inspectors.join(", ")}）`
        : (inspectors[0] || "未入力");

    return res.json({
      drone,
      period: { start, end },
      inspectors,
      flights: flightsOut,
      aggregated: {
        inspector: aggregatedInspector,
        records: aggregatedRecords,
      },
    });
  } catch (err) {
    console.error("❌ getInspections error:", err);
    res.status(500).json({ error: "Server error" });
  }
}
