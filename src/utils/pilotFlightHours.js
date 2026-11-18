import { Flight, Pilot } from "../models/index.js";

/** Parse flight.duration (HH:MM:SS, HH:MM, seconds number/string) → seconds. */
export function flightDurationToSeconds(duration) {
  if (duration === null || duration === undefined) return 0;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    return Math.max(0, Math.floor(duration));
  }
  const raw = String(duration).trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw));
  const m = raw.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  if (![h, min, s].every(Number.isFinite)) return 0;
  return h * 3600 + min * 60 + s;
}

/**
 * Cộng duration mọi chuyến bay có pilotId này → pilots.totalFlightHours (giờ thập phân, 2 chữ số).
 */
export async function recalculatePilotTotalFlightHours(pilotId) {
  if (pilotId == null || pilotId === "") return;
  const id = Number(pilotId);
  if (!Number.isFinite(id)) return;

  const rows = await Flight.findAll({
    where: { pilotId: id },
    attributes: ["duration"],
    raw: true,
  });

  let totalSec = 0;
  for (const row of rows) {
    totalSec += flightDurationToSeconds(row.duration);
  }

  const hours = Math.round((totalSec / 3600) * 100) / 100;
  await Pilot.update({ totalFlightHours: hours }, { where: { id } });
}

export async function recalculatePilotTotalFlightHoursForPilotIds(pilotIds) {
  const ids = [
    ...new Set(
      (pilotIds || [])
        .filter((x) => x != null && x !== "")
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n))
    ),
  ];
  await Promise.all(ids.map((id) => recalculatePilotTotalFlightHours(id)));
}
