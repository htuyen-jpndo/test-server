// Time formatting helpers (system-wide)

const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_OFFSET = "+09:00";

/**
 * Normalize an input duration to 24h `HH:MM`.
 * Accepts:
 * - seconds as number/string (e.g. 3661 -> "01:01")
 * - time strings "H:M", "HH:MM", "HH:MM:SS" (seconds are ignored)
 */
export function normalizeDurationToHHMM(input) {
  if (input === null || input === undefined) return "00:00";

  // seconds as number
  if (typeof input === "number" && Number.isFinite(input)) {
    return secondsToHHMM(input);
  }

  const raw = String(input).trim();
  if (!raw) return "00:00";

  // seconds as string
  if (/^\d+$/.test(raw)) {
    return secondsToHHMM(Number(raw));
  }

  // time string H:M(:S)
  const m = raw.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return "00:00";

  let hours = Number(m[1]);
  let minutes = Number(m[2]);

  if (!Number.isFinite(hours) || hours < 0) hours = 0;
  if (!Number.isFinite(minutes) || minutes < 0) minutes = 0;

  // carry overflow minutes into hours
  hours += Math.floor(minutes / 60);
  minutes = minutes % 60;

  if (hours > 99) hours = 99;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function serializeFlightForApi(flightInstanceOrPlain) {
  if (!flightInstanceOrPlain) return flightInstanceOrPlain;
  const plain =
    typeof flightInstanceOrPlain.toJSON === "function"
      ? flightInstanceOrPlain.toJSON()
      : { ...flightInstanceOrPlain };

  // Datetime fields as ISO timestamp-with-time-zone string
  if (plain.takeoffTime !== undefined) {
    plain.takeoffTime = toTimestampWithTimeZone(plain.takeoffTime);
  }
  if (plain.landTime !== undefined) {
    plain.landTime = toTimestampWithTimeZone(plain.landTime);
  }
  if (plain.createdAt !== undefined) {
    plain.createdAt = toTimestampWithTimeZone(plain.createdAt);
  }
  if (plain.updatedAt !== undefined) {
    plain.updatedAt = toTimestampWithTimeZone(plain.updatedAt);
  }

  if (plain.actionDate !== undefined) {
    plain.actionDate = toTimestampWithTimeZone(plain.actionDate);
  }

  if (plain.duration !== undefined) {
    plain.duration = normalizeDurationToHHMM(plain.duration);
  }

  return plain;
}

export function serializeUserOptionForApi(optionInstanceOrPlain) {
  if (!optionInstanceOrPlain) return optionInstanceOrPlain;
  const plain =
    typeof optionInstanceOrPlain.toJSON === "function"
      ? optionInstanceOrPlain.toJSON()
      : { ...optionInstanceOrPlain };

  if (plain.createdAt !== undefined) {
    plain.createdAt = toTimestampWithTimeZone(plain.createdAt);
  }
  if (plain.updatedAt !== undefined) {
    plain.updatedAt = toTimestampWithTimeZone(plain.updatedAt);
  }

  return plain;
}

export function serializeMaintenanceForApi(recordInstanceOrPlain) {
  if (!recordInstanceOrPlain) return recordInstanceOrPlain;
  const plain =
    typeof recordInstanceOrPlain.toJSON === "function"
      ? recordInstanceOrPlain.toJSON()
      : { ...recordInstanceOrPlain };

  // `date` is DATEONLY; leave as-is.
  if (plain.createdAt !== undefined) {
    plain.createdAt = toTimestampWithTimeZone(plain.createdAt);
  }
  if (plain.updatedAt !== undefined) {
    plain.updatedAt = toTimestampWithTimeZone(plain.updatedAt);
  }

  return plain;
}

/**
 * Format a datetime value to ISO 8601 with timezone offset ("timestamp with time zone" style).
 * Examples: 2025-12-26T10:11:12+09:00
 *
 * Supports Date objects, ISO strings, and MySQL DATETIME strings ("YYYY-MM-DD HH:mm:ss").
 */
export function toTimestampWithTimeZone(input, {
  timeZone = DEFAULT_TIME_ZONE,
  offset = DEFAULT_OFFSET,
} = {}) {
  if (input === null || input === undefined) return null;

  // Preserve DATEONLY values as-is
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return input.trim();
  }

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return formatDateToIsoWithOffset(input, timeZone, offset);
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // MySQL/TiDB DATETIME string: "YYYY-MM-DD HH:mm:ss" (or with .sss)
  const mysql = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/
  );
  if (mysql) {
    return `${mysql[1]}T${mysql[2]}${offset}`;
  }

  // Already ISO with timezone: normalize to configured timezone/offset
  const isoWithZone = /Z$|[+-]\d{2}:?\d{2}$/;
  if (isoWithZone.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return formatDateToIsoWithOffset(d, timeZone, offset);
  }

  // Fallback: try parsing; if parses, format in configured tz
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return formatDateToIsoWithOffset(d, timeZone, offset);
}

function secondsToHHMM(seconds) {
  let sec = Number(seconds);
  if (!Number.isFinite(sec) || sec < 0) sec = 0;

  const totalMinutes = Math.floor(sec / 60);
  let hours = Math.floor(totalMinutes / 60);
  let minutes = totalMinutes % 60;

  if (hours > 99) hours = 99;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatDateToIsoWithOffset(date, timeZone, offset) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });

  // en-CA yields parts that map cleanly to YYYY-MM-DD and HH:mm:ss
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const HH = get("hour");
  const MM = get("minute");
  const SS = get("second");

  if (![yyyy, mm, dd, HH, MM, SS].every(Boolean)) return null;
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}${offset}`;
}
