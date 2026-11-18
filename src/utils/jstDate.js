/**
 * Parse datetimes that MySQL returns as JST wall-clock strings
 * (`dateStrings: true`, Sequelize `timezone: "+09:00"`).
 *
 * `new Date("YYYY-MM-DD HH:mm:ss")` treats that wall clock as server-local time,
 * which is 9 hours off when the process runs in UTC. Strings that already carry
 * a zone (`Z` or `+09:00`) are absolute instants and are parsed as-is.
 */

const JST_OFFSET_HOURS = 9;

export function parseJstDateTime(input, { endOfDayForDateOnly = false } = {}) {
  if (input == null || input === "") return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;

  const raw = String(input).trim();
  if (!raw) return null;

  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?$/
  );
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hasTime = m[4] != null;
  const hour = hasTime ? Number(m[4]) : endOfDayForDateOnly ? 23 : 0;
  const minute = hasTime ? Number(m[5] ?? 0) : endOfDayForDateOnly ? 59 : 0;
  const second = hasTime ? Number(m[6] ?? 0) : endOfDayForDateOnly ? 59 : 0;
  let ms = 0;
  if (hasTime && m[7] != null) {
    ms = Number(String(m[7]).padEnd(3, "0"));
  } else if (!hasTime && endOfDayForDateOnly) {
    ms = 999;
  }

  if (![year, month, day, hour, minute, second, ms].every((n) => Number.isFinite(n))) return null;

  const utcMs = Date.UTC(year, month - 1, day, hour - JST_OFFSET_HOURS, minute, second, ms);
  const out = new Date(utcMs);
  return Number.isNaN(out.getTime()) ? null : out;
}
