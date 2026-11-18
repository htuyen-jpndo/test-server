// Best-effort timezone guessing and datetime normalization.
// NOTE: Without an explicit timezone/offset from the client, timezone is inherently ambiguous.

import geoip from "geoip-lite";

const DEFAULT_TZ_OFFSET_MINUTES = 9 * 60; // JST

const COUNTRY_TO_OFFSET_MINUTES = {
  // Primary targets
  JP: 9 * 60,
  VN: 7 * 60,

  // A few common neighbors (fixed-offset; DST not handled)
  KR: 9 * 60,
  CN: 8 * 60,
  HK: 8 * 60,
  TW: 8 * 60,
  TH: 7 * 60,
  SG: 8 * 60,
  MY: 8 * 60,
  ID: 7 * 60, // simplistic (ID has multiple timezones)
};

/**
 * Guess user's timezone offset (minutes east of UTC).
 *
 * Heuristics:
 * - If client sends `x-tz-offset-minutes`, use it (e.g. 540 for JST, 420 for VN).
 * - Else guess from `Accept-Language` (ja -> JST, vi -> ICT).
 * - Else default to JST.
 */
export function guessTzOffsetMinutesFromRequest(req) {
  const headerValue = req?.headers?.["x-tz-offset-minutes"];
  if (headerValue !== undefined) {
    const n = Number(String(headerValue).trim());
    if (Number.isFinite(n) && n >= -12 * 60 && n <= 14 * 60) return n;
  }

  // Best-effort from IP
  const ip = getClientIp(req);
  const ipOffset = guessOffsetMinutesFromIp(ip);
  if (ipOffset !== null) return ipOffset;

  const acceptLanguage = String(req?.headers?.["accept-language"] || "").toLowerCase();
  if (acceptLanguage.includes("ja")) return 9 * 60;
  if (acceptLanguage.includes("vi")) return 7 * 60;

  return DEFAULT_TZ_OFFSET_MINUTES;
}

function getClientIp(req) {
  // Prefer explicit forwarding headers if present.
  const xff = req?.headers?.["x-forwarded-for"];
  if (xff) {
    const first = String(xff).split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }

  const xri = req?.headers?.["x-real-ip"];
  if (xri) return normalizeIp(String(xri).trim());

  // Express populates req.ip (honors trust proxy)
  if (req?.ip) return normalizeIp(String(req.ip));

  const ra = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  return normalizeIp(String(ra || ""));
}

function normalizeIp(ip) {
  const raw = String(ip || "").trim();
  if (!raw) return "";
  // IPv4 mapped IPv6
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  // strip zone index (IPv6)
  const pct = raw.indexOf("%");
  if (pct !== -1) return raw.slice(0, pct);
  return raw;
}

function isLikelyPrivateIp(ip) {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  // basic private IPv4 ranges
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

function guessOffsetMinutesFromIp(ip) {
  if (!ip || isLikelyPrivateIp(ip)) return null;
  try {
    const lookup = geoip.lookup(ip);
    const country = lookup?.country;
    if (!country) return null;
    return COUNTRY_TO_OFFSET_MINUTES[country] ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse a local datetime input (no timezone) as if it were in `offsetMinutesEastOfUtc`.
 * Returns a Date representing the corresponding UTC instant.
 *
 * Accepts:
 * - ISO with timezone ("...Z" or "...+07:00") -> parsed directly
 * - "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm(:ss)" -> interpreted in offset
 */
export function parseLocalDateTimeWithOffsetToDate(input, offsetMinutesEastOfUtc) {
  if (input === null || input === undefined) return null;

  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // If the string already has timezone info, trust it.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Match common "YYYY-MM-DD HH:mm:ss" or ISO-like without zone.
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || 0);

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  // Treat the provided wall-clock time as being in offsetMinutesEastOfUtc.
  // Convert to UTC epoch: UTC = local - offset
  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) -
    offsetMinutesEastOfUtc * 60 * 1000;

  const out = new Date(utcMs);
  return Number.isNaN(out.getTime()) ? null : out;
}
