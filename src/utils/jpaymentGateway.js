/**
 * J-Payment server-to-server APIs (fixed server IP required; browser → ER003).
 * @see クレジットカード (実売上・取消・再オーソリ) 接続仕様書
 *
 * Hosts come from jpaymentEndpoints (real credit.j-payment.co.jp unless JPAYMENT_MOCK / JPAYMENT_BASE_URL).
 */

import {
  jpayAutoChargeStopUrl,
  jpayGatewayUrl,
  jpayLinkAutoChargeUpdateUrl,
  jpayReAuthUrl,
} from "./jpaymentEndpoints.js";

export function getJPayGatewayUrl() {
  return jpayGatewayUrl();
}
export function getJPayReAuthUrl() {
  return jpayReAuthUrl();
}
export function getJPayAutoChargeStopUrl() {
  return jpayAutoChargeStopUrl();
}
export function getJPayLinkAutoChargeUpdateUrl() {
  return jpayLinkAutoChargeUpdateUrl();
}

/** Real-gateway defaults. Call the getters above so a local mock can be opted in. */
export const JPAY_GATEWAY_URL = "https://credit.j-payment.co.jp/gateway/gateway.aspx";
export const JPAY_RE_AUTH_URL = "https://credit.j-payment.co.jp/gateway/re_auth.aspx";
export const JPAY_AUTO_CHARGE_STOP_URL = "https://credit.j-payment.co.jp/gateway/acsgate.aspx";
/** 自動課金カード変更（リンク方式） — J-Payment hosted page */
export const JPAY_LINK_AUTO_CHARGE_UPDATE_URL =
  "https://credit.j-payment.co.jp/link/creditcard/auto-charge/update";

/** jb values for gateway.aspx */
export const JPAY_GATEWAY_JOB = {
  SALES: "SALES",
  CANCEL: "CANCEL",
};

/**
 * Parse rt=1 HTML response (comma-separated).
 * Order: gid, rst, ap, ec, god, cod, am, tx, sf, ta, id, ps, (extra…)
 */
export function parseGatewayRt1Response(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { format: "empty", raw, success: false };
  }

  const erMatch = raw.match(/ER[:\s]*([A-Z0-9]+)/i);
  if (erMatch || /^ER/i.test(raw)) {
    return {
      format: "error",
      errorCode: erMatch?.[1] || "ER",
      raw,
      success: false,
    };
  }

  const parts = raw.split(",");
  if (parts.length < 2) {
    return { format: "unknown", raw, success: false };
  }

  const rst = parts[1]?.trim() || null;
  return {
    format: "rt1",
    raw,
    success: rst === "1",
    gid: parts[0]?.trim() || null,
    rst,
    ap: parts[2]?.trim() || null,
    ec: parts[3]?.trim() || null,
    god: parts[4]?.trim() || null,
    cod: parts[5]?.trim() || null,
    am: parts[6]?.trim() || null,
    tx: parts[7]?.trim() || null,
    sf: parts[8]?.trim() || null,
    ta: parts[9]?.trim() || null,
    id: parts[10]?.trim() || null,
    ps: parts[11]?.trim() || null,
    extra: parts.length > 12 ? parts.slice(12).join(",") : null,
  };
}

function buildGatewayBody({ aid, jb, tid, rt = "1", extra = {} }) {
  const params = new URLSearchParams({
    aid: String(aid || "").trim(),
    jb: String(jb || "").trim(),
    rt: String(rt ?? "1").trim(),
    tid: String(tid || "").trim(),
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params;
}

/**
 * POST gateway.aspx — 実売上 (SALES) or 取消 (CANCEL).
 * @param {{ aid: string, jb: 'SALES'|'CANCEL', tid: string, rt?: string, extra?: Record<string, string> }} params
 */
export async function postGatewayTransaction({ aid, jb, tid, rt = "1", extra = {} }) {
  const body = buildGatewayBody({ aid, jb, tid, rt, extra });
  const response = await fetchGatewayForm(getJPayGatewayUrl(), body);
  const text = await response.text();
  const parsed = parseGatewayRt1Response(text);
  return {
    httpOk: response.ok,
    httpStatus: response.status,
    request: { aid, jb, tid, rt },
    parsed,
    responseSnippet: String(text || "").slice(0, 500),
  };
}

/** 取消 — refund / void a captured (実売上) payment. tid = original settlement number (gid). */
export async function cancelGatewayTransaction({ aid, tid }) {
  return postGatewayTransaction({ aid, jb: JPAY_GATEWAY_JOB.CANCEL, tid, rt: "1" });
}

/** 実売上 — capture from auth. tid = auth settlement number. */
export async function salesGatewayTransaction({ aid, tid }) {
  return postGatewayTransaction({ aid, jb: JPAY_GATEWAY_JOB.SALES, tid, rt: "1" });
}

function isDuplicateStopResponse(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return false;
  return s.includes("already") || s.includes("duplicate") || s.includes("処理済") || s.includes("既に");
}

export function maskJPaymentAcid(acid) {
  const s = String(acid || "").trim();
  if (s.length <= 6) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

const GATEWAY_TIMEOUT_MS_DEFAULT = 10000;

/** J-Payment parameter / gateway errors are `ER` + 3 digits (ER003, ER024, …). */
const JPAY_ER_CODE = /\bER(\d{3})\b/i;

const STOP_ER_HINTS = {
  ER003: "Send acsgate from whitelisted server IP only (not browser/FE).",
  ER024: "Auto-charge is already stopped.",
  ER051: "Invalid or unknown parameter — verify aid/acid/cmd=1.",
};

export function getGatewayTimeoutMs() {
  const n = Number(
    process.env.JPAYMENT_GATEWAY_TIMEOUT_MS ||
      process.env.JPAYMENT_RECURRING_TIMEOUT_MS ||
      GATEWAY_TIMEOUT_MS_DEFAULT
  );
  if (!Number.isFinite(n) || n <= 0) return GATEWAY_TIMEOUT_MS_DEFAULT;
  return n;
}

export function extractJPaymentErCode(text) {
  const m = String(text || "").match(JPAY_ER_CODE);
  return m ? `ER${m[1]}` : null;
}

/**
 * Interpret acsgate.aspx body.
 * Spec (サブスクペイ): success is the fixed 2-letter result `OK`.
 * Empty body is not success. A bare "ER" substring is not an error code
 * (`USER`, `ORDER`, `SERVER` must not be treated as gateway failures).
 * ER024 means the auto-charge is already stopped.
 */
export function interpretAutoChargeStopBody(text, { httpStatus = 200 } = {}) {
  const trimmed = String(text ?? "").trim();
  const responseSnippet = trimmed.slice(0, 500) || null;
  const httpOk = httpStatus >= 200 && httpStatus < 300;

  if (!trimmed) {
    return {
      ok: false,
      reason: "empty_gateway_response",
      reasonDetail: "acsgate.aspx returned an empty body — cannot confirm stop.",
      errorCode: null,
      duplicateStop: false,
      responseSnippet: null,
    };
  }

  if (isDuplicateStopResponse(trimmed)) {
    return {
      ok: true,
      reason: "already_stopped",
      reasonDetail:
        "Gateway response indicates auto-charge was already stopped (duplicate / 処理済 / 既に).",
      errorCode: extractJPaymentErCode(trimmed),
      duplicateStop: true,
      responseSnippet,
    };
  }

  const errorCode = extractJPaymentErCode(trimmed);
  if (errorCode === "ER024") {
    return {
      ok: true,
      reason: "already_stopped",
      reasonDetail: "J-Payment ER024: auto-charge is already stopped.",
      errorCode,
      duplicateStop: true,
      responseSnippet,
    };
  }
  if (errorCode) {
    const hint =
      STOP_ER_HINTS[errorCode] ||
      "Check J-Payment acsgate (auto-charge stop) docs and merchant settings.";
    return {
      ok: false,
      reason: "gateway_er",
      reasonDetail: `J-Payment ${errorCode}: ${trimmed}. ${hint}`,
      errorCode,
      duplicateStop: false,
      responseSnippet,
    };
  }

  if (/^OK$/i.test(trimmed)) {
    if (!httpOk) {
      return {
        ok: false,
        reason: "http_error",
        reasonDetail: `acsgate HTTP ${httpStatus}; body: ${trimmed}`,
        errorCode: null,
        duplicateStop: false,
        responseSnippet,
      };
    }
    return {
      ok: true,
      reason: "stopped",
      reasonDetail: "acsgate cmd=1 returned OK.",
      errorCode: null,
      duplicateStop: false,
      responseSnippet,
    };
  }

  if (!httpOk) {
    return {
      ok: false,
      reason: "http_error",
      reasonDetail: `acsgate HTTP ${httpStatus}; body: ${trimmed}`,
      errorCode: null,
      duplicateStop: false,
      responseSnippet,
    };
  }

  return {
    ok: false,
    reason: "unknown_stop_failure",
    reasonDetail: `Unexpected acsgate response (HTTP ${httpStatus}): ${trimmed}. Expected OK.`,
    errorCode: null,
    duplicateStop: false,
    responseSnippet,
  };
}

function fetchGatewayForm(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(getGatewayTimeoutMs()),
  });
}

/**
 * Stop recurring auto-charge (acsgate.aspx cmd=1).
 * Separate from gateway.aspx CANCEL — pair with refund when ending a card subscription.
 */
export async function stopJPaymentAutoCharge({ aid, acid }) {
  const normalizedAcid = String(acid || "").trim();
  const acidMasked = maskJPaymentAcid(normalizedAcid);

  if (!normalizedAcid) {
    return {
      ok: true,
      attempted: false,
      skipped: true,
      reason: "no_acid",
      reasonDetail: "acid (recurringToken) is empty — acsgate stop was not called.",
      errorCode: null,
      httpStatus: null,
      status: null,
      responseSnippet: null,
      snippet: null,
      duplicateStop: false,
      acidMasked: null,
    };
  }

  const body = new URLSearchParams({
    aid: String(aid || "").trim(),
    acid: normalizedAcid,
    cmd: "1",
  });

  let response;
  let text = "";
  try {
    response = await fetchGatewayForm(getJPayAutoChargeStopUrl(), body);
    text = await response.text();
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      attempted: true,
      skipped: false,
      reason: timedOut ? "timeout" : "network_error",
      reasonDetail: timedOut
        ? `acsgate.aspx timed out after ${getGatewayTimeoutMs()}ms`
        : `Failed to reach acsgate.aspx: ${err?.message || String(err)}`,
      errorCode: null,
      httpStatus: null,
      status: null,
      responseSnippet: null,
      snippet: null,
      duplicateStop: false,
      acidMasked,
    };
  }

  const interpreted = interpretAutoChargeStopBody(text, { httpStatus: response.status });
  return {
    attempted: true,
    skipped: false,
    httpStatus: response.status,
    status: response.status,
    snippet: interpreted.responseSnippet,
    acidMasked,
    ...interpreted,
  };
}

export function recurringCycleCodeFromPlan(planType) {
  if (planType === "trial") return "2";
  return planType === "yearly" ? "8" : "4";
}

function jstPartsFromDate(date) {
  const jstMs = date.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
  };
}

/** Next billing date for J-Payment `nad` (YYYYMMDD, JST). */
export function formatNadYmdJst(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = jstPartsFromDate(d);
  const m = String(p.month).padStart(2, "0");
  const day = String(p.day).padStart(2, "0");
  return `${p.year}${m}${day}`;
}

