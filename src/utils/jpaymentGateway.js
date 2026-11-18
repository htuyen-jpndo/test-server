/**
 * J-Payment server-to-server APIs (fixed server IP required; browser → ER003).
 * @see クレジットカード (実売上・取消・再オーソリ) 接続仕様書
 */

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
  const response = await fetch(JPAY_GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
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

function extractGatewayErCode(snippet) {
  const m = String(snippet || "").match(/ER[:\s]*([A-Z0-9]+)/i);
  if (m?.[1]) return m[1];
  return String(snippet || "").includes("ER") ? "ER" : null;
}

const STOP_ER_HINTS = {
  ER003: "Send acsgate from whitelisted server IP only (not browser/FE).",
  ER051: "Invalid or unknown parameter — verify aid/acid/cmd=1.",
};

function resolveAutoRenewStopOutcome({ httpStatus, snippet, duplicateStop }) {
  const responseSnippet = String(snippet || "").slice(0, 500) || null;

  if (duplicateStop) {
    return {
      ok: true,
      reason: "already_stopped",
      reasonDetail:
        "Gateway response indicates auto-charge was already stopped (duplicate / 処理済 / 既に).",
      errorCode: null,
    };
  }

  if (!responseSnippet) {
    return {
      ok: false,
      reason: "empty_gateway_response",
      reasonDetail: "acsgate.aspx returned an empty body — cannot confirm stop.",
      errorCode: null,
    };
  }

  const errorCode = extractGatewayErCode(responseSnippet);
  if (errorCode) {
    const hint = STOP_ER_HINTS[errorCode] || "Check J-Payment acsgate (auto-charge stop) docs and merchant settings.";
    return {
      ok: false,
      reason: "gateway_er",
      reasonDetail: `J-Payment ${errorCode}: ${responseSnippet}. ${hint}`,
      errorCode,
    };
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      reason: "http_error",
      reasonDetail: `acsgate HTTP ${httpStatus}; body: ${responseSnippet}`,
      errorCode: null,
    };
  }

  return {
    ok: false,
    reason: "unknown_stop_failure",
    reasonDetail: `Unexpected acsgate response (HTTP ${httpStatus}): ${responseSnippet}`,
    errorCode: null,
  };
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
    response = await fetch(JPAY_AUTO_CHARGE_STOP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      skipped: false,
      reason: "network_error",
      reasonDetail: `Failed to reach acsgate.aspx: ${err?.message || String(err)}`,
      errorCode: null,
      httpStatus: null,
      status: null,
      responseSnippet: null,
      snippet: null,
      duplicateStop: false,
      acidMasked,
    };
  }

  const responseSnippet = String(text || "").slice(0, 500);
  const duplicateStop = isDuplicateStopResponse(responseSnippet);
  const httpStatus = response.status;
  const hasErInBody = responseSnippet.includes("ER");

  if ((response.ok && !hasErInBody) || duplicateStop) {
    const successReason = duplicateStop ? "already_stopped" : "stopped";
    const successDetail = duplicateStop
      ? "Auto-charge already stopped at gateway (treated as success)."
      : "acsgate cmd=1 completed successfully.";
    return {
      ok: true,
      attempted: true,
      skipped: false,
      reason: successReason,
      reasonDetail: successDetail,
      errorCode: null,
      httpStatus,
      status: httpStatus,
      responseSnippet: responseSnippet || null,
      snippet: responseSnippet || null,
      duplicateStop,
      acidMasked,
    };
  }

  const failure = resolveAutoRenewStopOutcome({ httpStatus, snippet: responseSnippet, duplicateStop });
  return {
    ok: false,
    attempted: true,
    skipped: false,
    duplicateStop: false,
    httpStatus,
    status: httpStatus,
    responseSnippet: responseSnippet || null,
    snippet: responseSnippet || null,
    acidMasked,
    ...failure,
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

